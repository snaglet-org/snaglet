/**
 * toolCatalogBlock — the `## MCP servers` section of the system prompt, plus
 * isSemanticSearchAvailable, the embedding check composeSystemPrompt runs once
 * per compose to set ctx.embeddingsEnabled.
 *
 * Only the agent's MCP tools are listed. The core tools are not: every
 * provider path that sends tools sends them natively with their full
 * descriptions and parameters, and the `tool` tool's own description teaches
 * discovery. The MCP tools travel natively too, so this section only orients:
 * which server each tool belongs to, with a short summary while the roster is
 * small. Its size is bounded by a rendered-text budget
 * (MCP_CATALOG_BUDGET_CHARS), not a tool count, since a small server can still
 * carry very long descriptions. Within the budget each server renders at the
 * richest level that fits, degrading the largest section first: one line per
 * tool with its first sentence, then the tool names on one line, then only the
 * count, pointing to `tool` search and schema lookup (or, for an agent without
 * the `tool` tool, to its own tool list). Servers and tools are sorted by id,
 * so the bytes are stable. With no MCP tools the block renders nothing.
 *
 * Part of the stable core: an agent's MCP roster changes only when a server is
 * enabled, disabled or edited. The block sets no cache_control of its own;
 * composeSystemPrompt places the system breakpoint.
 */

import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';
import type { BlockBuilder } from '../types';
import {
  resolveEmbeddingProvider,
  MockEmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';

let cachedSemanticAvailable: boolean | null = null;
let cachedAt = 0;
// Last-true latch (cache stickiness): once availability has been
// observed true in this process, never downgrade to false. Embedding
// availability is a process-lifetime fact (the built-in local embedder, or a
// test mock), so a transient blip or thrown error must not flip it back —
// this value feeds ctx.embeddingsEnabled, which is rendered into core
// system-prompt bytes; flapping it would bust the byte-identical system cache
// prefix on the next turn. A genuine removal is rare and picked up on restart.
let everSemanticAvailable = false;
const SEMANTIC_AVAILABILITY_TTL_MS = 60_000;

/**
 * Check whether a real (non-mock) embedding provider is available.
 * Cached for 60 s so successive blocks in the same compose call return
 * a stable answer without re-hitting the provider registry each time.
 * Exported so composeSystemPrompt can resolve it once and stamp
 * ctx.embeddingsEnabled before the block loop runs.
 *
 * Result is latched-true per process (see `everSemanticAvailable`) so the 60 s
 * cache can't flap the value across turns and bust the system-prompt cache.
 */
export async function isSemanticSearchAvailable(): Promise<boolean> {
  const now = Date.now();
  if (cachedSemanticAvailable !== null && now - cachedAt < SEMANTIC_AVAILABILITY_TTL_MS) {
    return cachedSemanticAvailable;
  }
  try {
    const provider = await resolveEmbeddingProvider();
    const live = provider !== null && !(provider instanceof MockEmbeddingProvider);
    if (live) everSemanticAvailable = true;
    cachedSemanticAvailable = live || everSemanticAvailable;
  } catch {
    // Transient failure — hold the latch rather than downgrading true→false.
    cachedSemanticAvailable = everSemanticAvailable;
  }
  cachedAt = now;
  return cachedSemanticAvailable;
}

/**
 * Most characters the section may render. Measured on synthetic rosters
 * (promptTokenBudget, PROMPT_TOKEN_REPORT=1): 12 short-description tools fit
 * as summaries (~310 tokens); 71 tools on three servers fit as names.
 */
const MCP_CATALOG_BUDGET_CHARS = 1600;
/** A summary is the description's first sentence, cut at this many characters. */
const SUMMARY_MAX_CHARS = 100;

type Level = 'summary' | 'names' | 'count';
const LEVELS: readonly Level[] = ['summary', 'names', 'count'];

interface Server {
  id: string;
  tools: ResolvedAgentTool[];
  level: number;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The description's first sentence on one line, cut to SUMMARY_MAX_CHARS. */
function summarize(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  const sentence = /^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  return sentence.length <= SUMMARY_MAX_CHARS
    ? sentence
    : `${sentence.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

/** The tool's name within its server: the id after `mcp__<server>__`. */
function shortName(id: string, serverId: string): string {
  const prefix = `mcp__${serverId}__`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function renderServer(server: Server, canSearch: boolean): string {
  const { id, tools } = server;
  const head = `**${id}** (${tools.length} tools)`;
  switch (LEVELS[server.level]) {
    case 'summary':
      return [
        `${head}:`,
        ...tools.map(({ tool }) => {
          const summary = summarize(tool.description ?? '');
          return summary ? `- ${tool.id} — ${summary}` : `- ${tool.id}`;
        }),
      ].join('\n');
    case 'names':
      return `${head}, ids \`mcp__${id}__<name>\`: ${tools.map(({ tool }) => shortName(tool.id, id)).join(', ')}`;
    default:
      return canSearch
        ? `${head}: find one with \`tool({op: 'search', query})\`, then \`tool({op: 'schema', name})\`.`
        : `${head}, each in your tool list.`;
  }
}

function renderMcpServers(mcp: ResolvedAgentTool[], canSearch: boolean): string {
  // Group by server (categoryPath is `integrations/<serverId>`).
  const groups = new Map<string, ResolvedAgentTool[]>();
  for (const at of mcp) {
    const serverId = at.tool.providerId ?? at.tool.categoryPath;
    const serverTools = groups.get(serverId) ?? [];
    serverTools.push(at);
    groups.set(serverId, serverTools);
  }
  const servers: Server[] = [...groups]
    .sort(([a], [b]) => byId(a, b))
    .map(([id, tools]) => ({
      id,
      tools: tools.sort((a, b) => byId(a.tool.id, b.tool.id)),
      level: 0,
    }));

  const render = () =>
    `## MCP servers\n${servers.map((server) => renderServer(server, canSearch)).join('\n\n')}`;
  let text = render();
  // Over budget: step the largest section that can still shrink down one
  // level (ties go to the first server by id), until it fits or all are counts.
  while (text.length > MCP_CATALOG_BUDGET_CHARS) {
    let largest: Server | null = null;
    let largestLength = -1;
    for (const server of servers) {
      if (server.level >= LEVELS.length - 1) continue;
      const length = renderServer(server, canSearch).length;
      if (length > largestLength) {
        largest = server;
        largestLength = length;
      }
    }
    if (!largest) break;
    largest.level += 1;
    text = render();
  }
  return text;
}

export const toolCatalogBlock: BlockBuilder = async (ctx) => {
  const mcp = ctx.agentTools.filter((at) => at.tool.type === 'mcp');
  if (mcp.length === 0) return null;
  // No cache_control here — composeSystemPrompt places the single stable-core
  // breakpoint on whichever core block renders last.
  const canSearch = ctx.agentTools.some((at) => at.tool.id === 'tool');
  return { type: 'text', text: renderMcpServers(mcp, canSearch) };
};
