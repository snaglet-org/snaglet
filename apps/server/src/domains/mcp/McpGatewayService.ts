/**
 * McpGatewayService: execution adapter between the /mcp endpoint and the
 * internal ToolService. A tools/call goes: boundary name -> curated allowlist
 * -> argument normalization (the executor's own steps, so policy sees what the
 * handler will) -> external policy checks -> runWithActor(external member) ->
 * toolExecutor.execute -> MCP-shaped result. The actor is the API key's member
 * (actorKind 'external', actorId = members.id), so attribution and telemetry
 * use the same chokepoints as native callers. No agentId/threadId goes on the
 * handler context: external scope is explicit ids.
 */

import path from 'path';
import { Projects } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { Automations } from '@snaglet/db/tables/automations';
import type { ToolRow } from '@snaglet/db';
import {
  isRecord,
  readToolOp,
  resolveToolId,
  safeJsonParse,
  transformToolAliasParams,
  type ResolvedToolId,
} from '@snaglet/shared/utils';
import { runWithActor } from '@server/realtime/actorContext';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import type { ToolDefinition } from '@server/services/ToolService/types';
import { normalizeToolParams } from '@server/services/ToolService/lib/normalizeToolParams';
import { unwrapDoubleWrappedInput } from '@server/services/ToolService/lib/unwrapDoubleWrappedInput';
import { toolOpEnum } from '@server/services/ToolService/lib/toolVisibility';
import { SNAGLET_HOME } from '@server/services/snagletHome';
import { HELPER_ROW_EDIT_REFUSAL } from '@server/services/subagents/subagentText';
import {
  MockEmbeddingProvider,
  resolveEmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
import { logger } from '@server/config/logger';
import {
  EXTERNAL_AUTOMATION_OPS,
  EXTERNAL_TABLE_SCHEMA_OPS,
  externalArgsError,
  fromMcpToolName,
  isExternalOpAllowed,
  MCP_TOOL_PREFIX,
  projectTools,
  type McpToolProjection,
} from './mcpProjection';
import { canonicalPath, confineToRoots, isWithinRoot } from './externalPathPolicy';

/** The authenticated external caller (from the API-key auth middleware). */
export interface ExternalCaller {
  /** members.id of the key's external member. */
  memberId: string;
  /** Key label — used as the actor display name ("Edited by <name>"). */
  name: string;
}

/** MCP CallToolResult content blocks: text, plus image blocks for tools that attach current-turn pixels. */
type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' };

interface McpCallResult {
  content: McpContentBlock[];
  isError?: boolean;
  /** Structural compat with the SDK's passthrough CallToolResult type. */
  [key: string]: unknown;
}

function textResult(text: string, isError = false): McpCallResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Image blocks a tool attached through the `rawContent.ephemeralInlineImages`
 * protocol (base64 + media type, current-turn only — the same shape the chat
 * dispatcher inlines for agents; see toolDispatch.ts). Externally they become
 * MCP image content blocks after the text, so a tool that attaches a
 * generated preview hands the client a real image. Non-conforming shapes yield no
 * blocks; the protocol allows one image per result.
 */
function imageBlocksFromRawContent(rawContent: unknown): McpContentBlock[] {
  if (!isRecord(rawContent) || !Array.isArray(rawContent.ephemeralInlineImages)) return [];
  const blocks: McpContentBlock[] = [];
  for (const candidate of rawContent.ephemeralInlineImages) {
    if (!isRecord(candidate)) continue;
    const { mediaType, data } = candidate;
    if (
      (mediaType === 'image/png' || mediaType === 'image/jpeg') &&
      typeof data === 'string' &&
      data.length > 0
    ) {
      blocks.push({ type: 'image', data, mimeType: mediaType });
    }
  }
  return blocks.slice(0, 1);
}

/** A policy denial — the call never reaches the tool. */
function denial(message: string): McpCallResult {
  return textResult(message, true);
}

/**
 * Policy verdict. `allow` may carry tool settings the gateway adds for this
 * call (e.g. the `root_dir` the code-search handler re-checks against).
 */
type PolicyOutcome =
  | { allowed: false; result: McpCallResult }
  | { allowed: true; settings: Record<string, unknown> };

const ALLOW: PolicyOutcome = { allowed: true, settings: {} };

function fromDenial(result: McpCallResult | null): PolicyOutcome {
  return result ? { allowed: false, result } : ALLOW;
}

/** table schema ops an external caller may run (an allow list). */
const EXTERNAL_SCHEMA_OPS_ALLOWED: ReadonlySet<string> = new Set(EXTERNAL_TABLE_SCHEMA_OPS.allowed);

/** automation ops that work on any automation; every other op is own-only. */
const EXTERNAL_AUTOMATION_OPEN_OPS: ReadonlySet<string> = new Set(EXTERNAL_AUTOMATION_OPS.open);

/**
 * The params an old tool id's transform copies `name` into (snaglet_move's
 * new_parent_id -> parent_id), read off the transform itself with a probe
 * value, so the external shape check accepts an old name exactly where it
 * stands for an allowed param.
 */
function renamedBy(resolution: ResolvedToolId | null, name: string): string[] {
  if (!resolution?.transformParams) return [];
  const probe = {};
  const out = resolution.transformParams({ [name]: probe });
  return Object.keys(out).filter((key) => key !== name && out[key] === probe);
}

/**
 * True when `mcpName` names a Snaglet tool, or an old id of one, that MCP clients
 * cannot use (create_image), as opposed to a name Snaglet does not know.
 */
function isAppLocalName(mcpName: string): boolean {
  if (!mcpName.startsWith(MCP_TOOL_PREFIX)) return false;
  const resolution = resolveToolId(mcpName.slice(MCP_TOOL_PREFIX.length));
  return !resolution.removed && toolRegistry.getDefinition(resolution.id) !== undefined;
}

/** Deeper wrapping than this is refused rather than unwrapped. */
const MAX_UNWRAP_DEPTH = 4;

/**
 * Synthesize the ResolvedAgentTool the executor expects from the registry
 * definition. External calls have no agent, so there are no per-agent
 * settings and no confirmation gate (the curated tier + policy checks are the
 * external permission layer).
 */
function toAgentTool(
  def: ToolDefinition,
  caller: ExternalCaller,
  settings: Record<string, unknown> = {}
) {
  const now = new Date().toISOString();
  const tool: ToolRow = {
    id: def.id,
    name: def.name,
    description: def.description,
    type: def.type,
    parametersSchema: def.parameters_schema,
    keywords: def.keywords,
    aliases: def.aliases ?? [],
    source: def.source ?? null,
    configJson: {},
    enabled: true,
    tier: def.tier,
    categoryPath: def.categoryPath,
    providerId: def.providerId ?? null,
    sortOrder: def.sort_order ?? 0,
    createdAt: now,
    updatedAt: now,
  };
  return {
    agentId: `mcp-external:${caller.memberId}`,
    tool,
    settings,
    requiresConfirmation: false,
  };
}

class McpGatewayService {
  private async ensureRegistry(): Promise<void> {
    if (!toolRegistry.isLoaded) {
      await toolRegistry.load();
    }
  }

  /** The external tools/list projection (curated tier only). */
  async listExternalTools(): Promise<McpToolProjection[]> {
    await this.ensureRegistry();
    const projected = projectTools(toolRegistry.getAllDefinitions());
    return projected;
  }

  /**
   * Execute an external tools/call. Never throws — every failure mode maps to
   * an MCP error result so the JSON-RPC layer stays clean.
   */
  async executeExternalToolCall(
    mcpName: string,
    args: Record<string, unknown>,
    caller: ExternalCaller
  ): Promise<McpCallResult> {
    await this.ensureRegistry();

    const toolId = fromMcpToolName(mcpName);
    if (!toolId) {
      return denial(
        isAppLocalName(mcpName)
          ? `Denied: ${mcpName} is not available to external MCP clients; it stays in the Snaglet app. Call tools/list for the Snaglet tools you can use.`
          : `Unknown tool: ${mcpName}. Call tools/list for the available Snaglet tools.`
      );
    }
    const exactDef = toolRegistry.getDefinition(toolId);
    const aliasResolution = resolveToolId(toolId);
    const def =
      exactDef ??
      (aliasResolution.removed ? undefined : toolRegistry.getDefinition(aliasResolution.id));
    if (!def) {
      return denial(`Tool ${mcpName} is unavailable on this server.`);
    }
    const executionArgs = this.prepareExecutionArgs(
      args,
      [toolId, aliasResolution.id, def.id],
      exactDef ? null : aliasResolution,
      def
    );
    if (!executionArgs) {
      return denial(
        'Denied: tool arguments are nested too deeply. Send the arguments object directly.'
      );
    }
    const executionToolId = def.id;

    // op tools: the curated tier may expose only some ops. Checked on the
    // final (alias-pinned) args, so neither an alias id nor a raw `op` can
    // reach an op that is not curated. An op the tool does not have at
    // all is named as such (not as a policy denial) with the external ops.
    const op = readToolOp(executionArgs);
    const toolOps = toolOpEnum({ parametersSchema: def.parameters_schema });
    if (op !== null && toolOps.length > 0 && !toolOps.includes(op)) {
      // A family alias (snaglet_calendar_read) turns an op outside its family into
      // a sentinel: name what the caller sent, and only the family's ops.
      const family = exactDef ? null : (aliasResolution.ops ?? null);
      const external = toolOps.filter(
        (candidate) =>
          (!family || family.includes(candidate)) && isExternalOpAllowed(executionToolId, candidate)
      );
      const requested = family ? readToolOp(args) : op;
      return denial(
        requested === null
          ? `${mcpName} needs an op; external ops: ${external.join(', ')}.`
          : `\`${requested}\` is not an op of ${mcpName}; external ops: ${external.join(', ')}.`
      );
    }
    if (!isExternalOpAllowed(executionToolId, op)) {
      return denial(
        `Denied: op \`${op ?? '(none)'}\` of ${mcpName} is not available to external MCP clients.`
      );
    }
    // The published schema is the external contract: a param, object field or
    // enum value it leaves out is refused here, before any policy or handler.
    const shapeError = externalArgsError(def, op, executionArgs, mcpName, (name) =>
      renamedBy(exactDef ? null : aliasResolution, name)
    );
    if (shapeError) return denial(`Denied: ${shapeError}`);

    const policy = await this.checkExternalPolicy(executionToolId, executionArgs, caller);
    if (!policy.allowed) return policy.result;

    logger.info(`[mcp-gateway] ${caller.name} (${caller.memberId}) -> ${executionToolId}`);

    const result = await runWithActor(
      { actorId: caller.memberId, actorKind: 'external', actorName: caller.name },
      () =>
        toolExecutor.execute(
          { name: toolId, input: executionArgs },
          toAgentTool(def, caller, policy.settings),
          {}
        )
    );

    if (!result.success) {
      return textResult(result.error ?? `Tool ${mcpName} failed.`, true);
    }
    if (executionToolId === 'search' && executionArgs.kind === 'files') {
      // Belt over the pre-flight braces: if the keyword/filesystem arm ran
      // anyway, discard it — external callers get semantic results or an
      // honest empty, never a host-filesystem enumeration.
      const filtered = this.filterSemanticOnly(result.output);
      if (filtered) return textResult(filtered);
    }
    const shaped = textResult(result.output);
    shaped.content.push(...imageBlocksFromRawContent(result.rawContent));
    return shaped;
  }

  /**
   * Reproduce the executor's argument pipeline — unwrap a double-wrapped
   * `{function_name, arguments}` envelope, apply the alias transform, fill
   * `param_aliases` — so every policy check below inspects the exact input
   * the handler will receive. Without this, `{ container_id }` on
   * snaglet_update_container (arriving as `container` op update) or a wrapped `{ arguments: { kind:"code" } }`
   * would pass the checks and only become dangerous inside the executor.
   * Returns null when the input is wrapped deeper than MAX_UNWRAP_DEPTH.
   */
  private prepareExecutionArgs(
    args: Record<string, unknown>,
    invokedIds: string[],
    aliasResolution: ResolvedToolId | null,
    def: ToolDefinition
  ): Record<string, unknown> | null {
    let current = args;
    for (let depth = 0; ; depth += 1) {
      const unwrapped = unwrapDoubleWrappedInput(current, invokedIds);
      if (!unwrapped) break;
      if (depth >= MAX_UNWRAP_DEPTH) return null;
      current = unwrapped.input;
    }
    const aliased = aliasResolution ? transformToolAliasParams(aliasResolution, current) : current;
    return { ...normalizeToolParams(aliased, def.param_aliases) };
  }

  /**
   * External-caller policy for what the published schema cannot express: the
   * agent roster form, helper rows, table schema ops inside `ops[]`,
   * own-only automation writes, and the file and code search confinement.
   * Params, object fields and enum values outside the schema were refused
   * already (externalArgsError). Returns a denial, or an allow carrying any
   * extra tool settings for this call. External members have no per-member
   * permission policy, so these denials are unconditional.
   */
  private async checkExternalPolicy(
    toolId: string,
    args: Record<string, unknown>,
    caller: ExternalCaller
  ): Promise<PolicyOutcome> {
    // The policies key on the op (old ids arrive op-pinned).
    const op = readToolOp(args);
    if (toolId === 'agent' && op === 'get') {
      // The slim roster only: an external get is the roster form.
      args.listAll = true;
      return ALLOW;
    }
    if (toolId === 'agent' && op === 'update') {
      return fromDenial(await this.checkAgentUpdatePolicy(args));
    }
    if (toolId === 'table' && op === 'schema') {
      return fromDenial(this.checkTableSchemaPolicy(args));
    }
    if (toolId === 'automation') {
      return fromDenial(await this.checkAutomationPolicy(op, args, caller));
    }
    // calendar has no check here: the tool judges an external caller's rows
    // and automations, set_reminders own-only included, from the curation
    // (externalCalendarAccess in mcpProjection).
    if (toolId === 'search') {
      return this.checkSearchPolicy(args);
    }
    return ALLOW;
  }

  /**
   * agent update: the schema already limits it to agent_id, name, role,
   * identity, provider and model_id (EXTERNAL_OP_PARAMS). A subagent helper's
   * row is Snaglet's (its orchestrator changes it); the tool lets a person edit it,
   * and an external caller counts as one, so it is refused here.
   */
  private async checkAgentUpdatePolicy(
    args: Record<string, unknown>
  ): Promise<McpCallResult | null> {
    const agentId = typeof args.agent_id === 'string' ? args.agent_id.trim() : '';
    const target = agentId ? await Agents.findById(agentId) : null;
    return target?.parentAgentId ? denial(`Denied: ${HELPER_ROW_EDIT_REFUSAL}`) : null;
  }

  /**
   * table schema: creating and altering tables is open; archiving or deleting
   * a table or field is app-local (external callers have no confirmation
   * step). Fails closed: only EXTERNAL_TABLE_SCHEMA_OPS.allowed runs, so a new
   * op or a malformed item is refused until classified there. update_field's
   * `clear_repeats` is app-local for the same reason (it removes every row's
   * repeat); other repeat and calendar changes stay open.
   */
  private checkTableSchemaPolicy(args: Record<string, unknown>): McpCallResult | null {
    if (!Array.isArray(args.ops)) return null;
    const denied = args.ops
      .map((item) => (isRecord(item) && typeof item.op === 'string' ? item.op : '(none)'))
      .filter((op) => !EXTERNAL_SCHEMA_OPS_ALLOWED.has(op));
    if (denied.length === 0) {
      const clearing = args.ops.some(
        (item) => isRecord(item) && item.clear_repeats !== undefined && item.clear_repeats !== false
      );
      if (!clearing) return null;
      return denial(
        'Denied: table schema `clear_repeats` is app-local for external MCP clients: it removes ' +
          "every row's repeat. Nothing was changed; turn the field's repeats off in the Snaglet app."
      );
    }
    const names = [...new Set(denied)];
    return denial(
      `Denied: table schema ${names.map((op) => `\`${op}\``).join(', ')} ` +
        `${names.length === 1 ? 'is' : 'are'} app-local for external MCP clients ` +
        `(they may run ${EXTERNAL_TABLE_SCHEMA_OPS.allowed.join(', ')}). Nothing was changed; ` +
        'archive or delete tables and fields from the Snaglet app.'
    );
  }

  /**
   * automation(op): create must name its thread and agent explicitly (there is
   * no ambient one), and writes to an existing automation work only on ones
   * this key's member created (`created_by_member_id`). Own-only is the
   * default: only EXTERNAL_AUTOMATION_OPS.open skips it, so a new op is
   * own-only until classified. A missing automation is left to the tool's
   * own not-found.
   */
  private async checkAutomationPolicy(
    op: string | null,
    args: Record<string, unknown>,
    caller: ExternalCaller
  ): Promise<McpCallResult | null> {
    if (op === 'create') {
      const missing = ['thread_id', 'agent_id'].filter(
        (key) => typeof args[key] !== 'string' || !(args[key] as string).trim()
      );
      if (missing.length === 0) return null;
      return denial(
        `Denied: automation create needs explicit ${missing.join(' and ')} for external MCP ` +
          'clients (there is no ambient thread or agent). Find them with snaglet_thread and snaglet_agent.'
      );
    }
    if (op !== null && EXTERNAL_AUTOMATION_OPEN_OPS.has(op)) return null;
    return this.checkOwnAutomation(args.id, caller, `automation ${op ?? '(none)'}`);
  }

  /**
   * Own-only: `what` may touch automation `id` only when this key's member
   * created it. An id that is not text, or names no automation, is left to
   * the tool (its own validation and not-found).
   */
  private async checkOwnAutomation(
    id: unknown,
    caller: ExternalCaller,
    what: string
  ): Promise<McpCallResult | null> {
    if (typeof id !== 'string' || !id.trim()) return null;
    const automation = await Automations.findById(id.trim());
    if (!automation || automation.createdByMemberId === caller.memberId) return null;
    return denial(
      `Denied: ${what} works only on automations this MCP key's member created. ` +
        'Change this one from the Snaglet app.'
    );
  }

  /**
   * Per-kind constraints on the search tool. Which kinds an external caller
   * may use is EXTERNAL_ENUM_VALUES (no `database`), checked already;
   * kinds:["entry"] (table rows) reads only the custom tables the curated
   * `table` tool already serves.
   */
  private async checkSearchPolicy(args: Record<string, unknown>): Promise<PolicyOutcome> {
    const kind = args.kind;
    if (kind === 'files') return fromDenial(await this.checkSemanticFileSearchPolicy(args));
    if (kind === 'code') return this.checkCodeSearchPolicy(args);
    return ALLOW;
  }

  /**
   * kind:"code" runs ripgrep over the host filesystem, so external callers are
   * confined to linked project folders: `project_id` (path optional, relative
   * to the project folder) or an absolute `path` inside some project folder.
   * The vetted canonical path replaces `args.path` in place, so the handler
   * searches exactly what was checked and never falls back to the server's
   * cwd; `root_dir` makes the handler re-check it.
   */
  private async checkCodeSearchPolicy(args: Record<string, unknown>): Promise<PolicyOutcome> {
    const projectId = typeof args.project_id === 'string' ? args.project_id.trim() : '';
    const rawPath = typeof args.path === 'string' ? args.path.trim() : '';

    let roots: string[];
    let candidate: string;
    if (projectId) {
      const project = await Projects.findById(projectId);
      if (!project) {
        return fromDenial(
          denial(`Unknown project_id: ${projectId}. Find project ids via snaglet_node op:tree.`)
        );
      }
      if (!project.folderPath) {
        return fromDenial(
          denial('Denied: that project has no linked folder, so there is no code to search.')
        );
      }
      roots = [project.folderPath];
      candidate = path.resolve(project.folderPath, rawPath || '.');
    } else {
      if (!rawPath || !path.isAbsolute(rawPath)) {
        return fromDenial(
          denial(
            'Denied: kind:"code" requires `project_id` (find one via snaglet_node op:tree) or an ' +
              'absolute `path` inside a linked project folder for external MCP clients.'
          )
        );
      }
      const projects = await Projects.listAll();
      roots = projects
        .map((project) => project.folderPath)
        .filter((folder): folder is string => typeof folder === 'string' && folder.length > 0);
      candidate = rawPath;
    }

    const confined = await confineToRoots(candidate, roots, SNAGLET_HOME);
    if (!confined.ok) {
      return fromDenial(
        denial(
          `Denied: code search is limited to linked project folders for external MCP clients ` +
            `(${confined.reason}).`
        )
      );
    }
    args.path = confined.target;
    return { allowed: true, settings: { root_dir: confined.root } };
  }

  /**
   * semantic_file_search external constraint:
   * semantic arm only. project_id is required; the host-filesystem fallback is
   * disabled; an unindexed project returns an honest empty. The pre-flight
   * reproduces the tool's own vector-arm gate (embeddings available + project
   * root + path inside project) so the fallback arm can never execute.
   */
  private async checkSemanticFileSearchPolicy(
    args: Record<string, unknown>
  ): Promise<McpCallResult | null> {
    const projectId = typeof args.project_id === 'string' ? args.project_id.trim() : '';
    if (!projectId) {
      return denial(
        'semantic_file_search requires `project_id` for external callers. Find project ids ' +
          'via snaglet_node op:tree, then retry with project_id set.'
      );
    }

    const project = await Projects.findById(projectId);
    if (!project) {
      return denial(`Unknown project_id: ${projectId}. Find project ids via snaglet_node op:tree.`);
    }

    const root = project.folderPath ? path.resolve(project.folderPath) : null;
    if (!root) {
      return this.honestEmpty('Project has no linked folder, so it is not semantically indexed.');
    }

    if (typeof args.path === 'string' && args.path.trim() !== '') {
      const target = path.resolve(root, args.path.trim());
      // Lexical check first, then the canonical one: a symlink inside the
      // project can point anywhere, and the handler's grep would follow it.
      const canonicalRoot = (await canonicalPath(root)) ?? root;
      const canonicalTarget = await canonicalPath(target);
      if (
        !isWithinRoot(root, target) ||
        (canonicalTarget !== null && !isWithinRoot(canonicalRoot, canonicalTarget))
      ) {
        return denial(
          '`path` must stay inside the project folder for external callers ' +
            "(the search is scoped to the project's semantic index)."
        );
      }
    }

    const embeddingsReady = await this.embeddingsAvailable();
    if (!embeddingsReady) {
      return this.honestEmpty(
        'The built-in embedding model is not available, so the semantic index cannot be searched.'
      );
    }
    return null;
  }

  /** Mirrors the tool's own vector-arm availability check. */
  private async embeddingsAvailable(): Promise<boolean> {
    try {
      const provider = await resolveEmbeddingProvider();
      return provider !== null && !(provider instanceof MockEmbeddingProvider);
    } catch {
      return false;
    }
  }

  /** Honest empty result — semantic arm unavailable, fallback disabled. */
  private honestEmpty(reason: string): McpCallResult {
    return textResult(
      JSON.stringify(
        {
          indexed: false,
          matchedOn: 'semantic',
          count: 0,
          files: [],
          note:
            `${reason} External callers receive semantic results only — the filesystem ` +
            'fallback is disabled for MCP clients, so this is an honest empty set.',
        },
        null,
        2
      )
    );
  }

  /**
   * Post-filter for semantic_file_search: if the tool's keyword/filesystem
   * arm produced the output (indexed: false), replace it with an honest empty.
   * Returns the replacement text, or null to keep the original output.
   */
  private filterSemanticOnly(output: string): string | null {
    const parsed = safeJsonParse<{ indexed?: boolean } | null>(output, null);
    if (parsed && parsed.indexed === false) {
      const [block] = this.honestEmpty(
        'The project is not semantically indexed for this scope.'
      ).content;
      return block?.type === 'text' ? block.text : null;
    }
    return null;
  }
}

export const mcpGatewayService = new McpGatewayService();
