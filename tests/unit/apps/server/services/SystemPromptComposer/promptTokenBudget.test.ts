/**
 * Whole-request token budget for representative agents, offline: every system
 * block, the advertised tools array (the real core tool definitions on the
 * wire) and the per-turn context tail. It complements blockTokenCeilings (one
 * fixture per block) by measuring what a real agent sends, so growth in any
 * part is noticed.
 *
 *   A — a plain agent in its home thread (DM): the core tools and built-in skills.
 *   B — the same agent in a group thread with three other agents (the normal
 *       agent; it calls found tools through the `action` gateway).
 *   C — many tools: core plus a small MCP roster (12 pinned tools on two
 *       servers), user skills on top of the built-ins, a project with a folder,
 *       workspace and thread instructions, and a long custom system prompt.
 *   D — a subagent helper in its own thread: the core tools a helper keeps.
 *   E — tool discovery off: the core tools without `tool` (defensive variant).
 *   F — no gateway: the core tools without `action` (found tools are called
 *       by id).
 *   G — a large MCP roster: 71 pinned tools on three servers, one of them a
 *       small server whose few descriptions are long.
 *
 * Tokens use the Anthropic char-ratio estimator the runtime budgets with.
 * Ceilings ≈ measured + 10%; the trailing comments record the measured
 * values, so a retune is a reviewable one-line edit.
 *
 * PROMPT_TOKEN_REPORT=1 prints a per-block table for every case, then the
 * system, tools-array, tail and total counts.
 */

jest.mock('@snaglet/db/tables/users', () => ({
  Users: { getActiveUser: jest.fn().mockResolvedValue({ name: 'Test User' }) },
}));
jest.mock('@server/services/SystemPromptComposer/hostMachine', () => ({
  describeHostMachine: () =>
    'a MacBook Pro running macOS 15.5 (Darwin 24.5.0, arm64), 12 cores, 36 GB RAM',
}));
jest.mock('@server/services/snagletHome', () => ({
  ...jest.requireActual('@server/services/snagletHome'),
  SNAGLET_SKILLS_DIR: '/Users/someone/.snaglet/skills',
}));
let mockInstructions = '';
jest.mock('@server/services/settings', () => ({
  settingsService: { read: jest.fn(async () => mockInstructions) },
}));
let mockEmbeddings = false;
jest.mock('@server/services/SystemPromptComposer/blocks/toolCatalogBlock', () => ({
  __esModule: true,
  ...jest.requireActual('@server/services/SystemPromptComposer/blocks/toolCatalogBlock'),
  isSemanticSearchAvailable: async () => mockEmbeddings,
}));

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { estimateTokens } from '@server/services/TokenEstimator';
import { toAnthropicTools } from '@server/services/ToolService/ToolFormatService';
import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import { parseSkillMarkdown } from '@server/services/skills/skillFile';
import { CORE_TOOL_ORDER, SUBAGENT_DENIED_TOOL_IDS } from '@snaglet/shared/constants';
import { identityBlock } from '@server/services/SystemPromptComposer/blocks/identityBlock';
import { toolDiscoveryBlock } from '@server/services/SystemPromptComposer/blocks/toolDiscoveryBlock';
import { operatingContextBlock } from '@server/services/SystemPromptComposer/blocks/operatingContextBlock';
import { goldenRulesBlock } from '@server/services/SystemPromptComposer/blocks/goldenRulesBlock';
import { howToActBlock } from '@server/services/SystemPromptComposer/blocks/howToActBlock';
import { perceptionBlock } from '@server/services/SystemPromptComposer/blocks/perceptionBlock';
import { runModeBlock } from '@server/services/SystemPromptComposer/blocks/runModeBlock';
import { subagentBlock } from '@server/services/SystemPromptComposer/blocks/subagentBlock';
import { toolCatalogBlock } from '@server/services/SystemPromptComposer/blocks/toolCatalogBlock';
import { workspaceInstructionsBlock } from '@server/services/SystemPromptComposer/blocks/workspaceInstructionsBlock';
import { skillCatalogBlock } from '@server/services/SystemPromptComposer/blocks/skillCatalogBlock';
import { threadSystemPromptBlock } from '@server/services/SystemPromptComposer/blocks/threadSystemPromptBlock';
import { composeSystemPrompt } from '@server/services/SystemPromptComposer/composeSystemPrompt';
import {
  composeTurnContextData,
  TURN_CONTEXT_HEADER,
} from '@server/services/SystemPromptComposer/composeTurnContextTail';
import { toolDiscoveryReminder } from '@server/services/SystemPromptComposer/blocks/toolDiscoveryBlock';
import type {
  BlockBuilder,
  SystemPromptContext,
} from '@server/services/SystemPromptComposer/types';
import { makeCtx, makeTool } from './composeFixtures';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const tokens = (text: string) => estimateTokens(text, 'anthropic');

/** composeSystemPrompt's order; the sum is checked against a real compose. */
const BLOCKS: Array<[string, BlockBuilder]> = [
  ['identityBlock', identityBlock],
  ['toolDiscoveryBlock', toolDiscoveryBlock],
  ['operatingContextBlock', operatingContextBlock],
  ['goldenRulesBlock', goldenRulesBlock],
  ['howToActBlock', howToActBlock],
  ['perceptionBlock', perceptionBlock],
  ['runModeBlock', runModeBlock],
  ['subagentBlock', subagentBlock],
  ['toolCatalogBlock', toolCatalogBlock],
  ['workspaceInstructionsBlock', workspaceInstructionsBlock],
  ['skillCatalogBlock', skillCatalogBlock],
  ['threadSystemPromptBlock', threadSystemPromptBlock],
];

function loadDefinitions(): Map<string, BuiltinToolDefinition> {
  const defs = new Map<string, BuiltinToolDefinition>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'definition.ts') {
        const def = require(full).default as BuiltinToolDefinition | undefined;
        if (def?.id) defs.set(def.id, def);
      }
    }
  };
  walk(path.join(REPO_ROOT, 'apps/server/src/services/ToolService/tools'));
  return defs;
}

const DEFS = loadDefinitions();

/** The agent's real advertised set in access mode All: every core tool. */
const CORE_TOOLS = CORE_TOOL_ORDER.map((id) => {
  const def = DEFS.get(id)!;
  return makeTool({
    id,
    name: def.name,
    description: def.description,
    tier: 'core',
    parametersSchema: def.parameters_schema,
  });
});

const BUILTIN_SKILLS = readdirSync(path.join(REPO_ROOT, 'apps/server/builtin-skills')).map(
  (slug) => {
    const raw = readFileSync(
      path.join(REPO_ROOT, 'apps/server/builtin-skills', slug, 'SKILL.md'),
      'utf8'
    );
    const parsed = parseSkillMarkdown(raw);
    return { slug, description: parsed.ok ? parsed.value.description : '' };
  }
);

const mcpTool = (server: string, name: string, description: string) =>
  makeTool({
    id: `mcp__${server}__${name}`,
    name,
    type: 'mcp',
    providerId: server,
    categoryPath: `integrations/${server}`,
    description,
  });

/** Small roster: two servers, six short-description tools each. */
const MCP_TOOLS = ['linear', 'github'].flatMap((server) =>
  Array.from({ length: 6 }, (_, i) =>
    mcpTool(
      server,
      `tool_${i}`,
      `Runs ${server} operation ${i} on issues, pull requests and comments.`
    )
  )
);

/**
 * Clauses real MCP descriptions are made of (filters, return shape, paging,
 * scope, errors, limits), cycled to reach a target length deterministically.
 */
const CLAUSES = [
  'Filters by state, labels, assignee and date range.',
  'Returns ids, titles, URLs and timestamps for each match.',
  'Supports cursor pagination; pass the cursor from the previous page.',
  'Needs a repository or project scope and defaults to the configured one.',
  'Errors name the missing permission when the token lacks a scope.',
  'Large results are cut to the first 100 items.',
];

function longDescription(server: string, i: number, chars: number): string {
  let text = `Runs ${server} operation ${i} on the items it manages.`;
  for (let c = i; text.length < chars; c++) text += ` ${CLAUSES[c % CLAUSES.length]}`;
  return text;
}

/**
 * Large roster, shaped like real servers: a code host with many mid-length
 * descriptions, a browser driver with many short ones, and a small notes
 * server whose few descriptions are long (a count cap does not bound them).
 */
const LARGE_MCP_TOOLS = [
  ...Array.from({ length: 40 }, (_, i) =>
    mcpTool('codehost', `op_${i}`, longDescription('codehost', i, 140))
  ),
  ...Array.from({ length: 25 }, (_, i) =>
    mcpTool('browserdriver', `op_${i}`, longDescription('browserdriver', i, 110))
  ),
  ...Array.from({ length: 6 }, (_, i) =>
    mcpTool('notes', `op_${i}`, longDescription('notes', i, 1200))
  ),
];

const USER_SKILLS = Array.from({ length: 5 }, (_, i) => ({
  slug: `team-skill-${i}`,
  description:
    'Load when the user asks for a weekly status report across the team projects; covers which tables and docs to read, how to summarize blockers, and where to file the report.',
}));

interface Case {
  ctx: SystemPromptContext;
  instructions: string;
}

const CASE_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
type CaseName = (typeof CASE_NAMES)[number];

const without = (...ids: string[]) => CORE_TOOLS.filter((at) => !ids.includes(at.tool.id));

/** A group-thread agent with the given advertised tools (B's shape). */
function groupCtx(agentTools: typeof CORE_TOOLS): SystemPromptContext {
  return {
    ...makeCtx({
      agentTools,
      isGroup: true,
      dispatchMode: 'mentioned',
      participantAgentIds: ['agent-self', 'agent-2', 'agent-3', 'agent-4'],
    }),
    skillCatalog: BUILTIN_SKILLS,
  } as SystemPromptContext;
}

function cases(): Record<CaseName, Case> {
  const A = {
    ...makeCtx({ agentTools: CORE_TOOLS }),
    isDm: true,
    skillCatalog: BUILTIN_SKILLS,
  } as SystemPromptContext;
  const B = {
    ...makeCtx({
      agentTools: CORE_TOOLS,
      isGroup: true,
      dispatchMode: 'mentioned',
      participantAgentIds: ['agent-self', 'agent-2', 'agent-3', 'agent-4'],
      systemPrompt:
        'You are the team researcher. Find sources, compare them, and write findings into the project doc. Prefer primary sources and say how sure you are.',
    }),
    skillCatalog: BUILTIN_SKILLS,
  } as SystemPromptContext;
  const C = {
    ...makeCtx({
      agentTools: [...CORE_TOOLS, ...MCP_TOOLS],
      isGroup: true,
      dispatchMode: 'all',
      participantAgentIds: ['agent-self', 'agent-2', 'agent-3'],
      runParams: {
        host_path: '/repos/vega',
        host_path_source: 'project',
        thread_title: 'Rollout',
        thread_path: '/Snaglet/projects/vega/threads',
        thread_routing: 'all',
        thread_participants: 'Peer One, Peer Two',
        project_name: 'Vega',
        project_folder_path: '/repos/vega',
        project_gitrepo: 'git@github.com:example/vega.git',
      },
      systemPrompt: 'You are the release manager. '.repeat(20),
      threadSystemPrompt: 'Post a daily status doc before ending your turn. '.repeat(4),
      embeddingsEnabled: true,
    }),
    skillCatalog: [...BUILTIN_SKILLS, ...USER_SKILLS],
    embeddingsEnabled: true,
  } as SystemPromptContext;
  const helperBase = makeCtx({ agentTools: without(...SUBAGENT_DENIED_TOOL_IDS) });
  const D = {
    ...helperBase,
    agent: { ...helperBase.agent, parentAgentId: 'agent-orchestrator' },
    isHelperThread: true,
    skillCatalog: BUILTIN_SKILLS,
  } as SystemPromptContext;
  return {
    A: { ctx: A, instructions: '' },
    B: { ctx: B, instructions: '' },
    C: {
      ctx: C,
      instructions:
        'Always write in American English. Keep answers short and link the docs you used. '.repeat(
          3
        ),
    },
    D: { ctx: D, instructions: '' },
    E: { ctx: groupCtx(without('tool')), instructions: '' },
    F: { ctx: groupCtx(without('action')), instructions: '' },
    G: { ctx: groupCtx([...CORE_TOOLS, ...LARGE_MCP_TOOLS]), instructions: '' },
  };
}

interface Measured {
  blocks: Record<string, number>;
  system: number;
  tools: Record<string, number>;
  toolsArray: number;
  tail: number;
  total: number;
}

async function measure({ ctx, instructions }: Case): Promise<Measured> {
  mockInstructions = instructions;
  const blocks: Record<string, number> = {};
  let system = 0;
  for (const [name, build] of BLOCKS) {
    const block = await build(ctx);
    blocks[name] = block ? tokens(block.text) : 0;
    system += blocks[name]!;
  }
  const tools: Record<string, number> = {};
  let toolsArray = 0;
  for (const at of ctx.agentTools) {
    const [wire] = toAnthropicTools([at.tool]);
    tools[at.tool.id] = tokens(JSON.stringify(wire));
    toolsArray += tools[at.tool.id]!;
  }
  const tailText = [
    TURN_CONTEXT_HEADER,
    composeTurnContextData(ctx),
    toolDiscoveryReminder(ctx.agentTools) ?? '',
  ].join('\n\n');
  const tail = tokens(tailText);
  return { blocks, system, tools, toolsArray, tail, total: system + toolsArray + tail };
}

/** Each block's ceiling across the cases (its largest rendering). */
const BLOCK_CEILINGS: Record<string, number> = {
  identityBlock: 339, // measured 308 in C (its long custom prompt is user content); A 151
  toolDiscoveryBlock: 428, // measured 389; 107 with tool search off
  operatingContextBlock: 1265, // measured 1150 (1136 in a home thread)
  goldenRulesBlock: 980, // measured 891 (778 for a helper); was 1206 with the default attitude
  howToActBlock: 429, // measured 390 for a helper, 378 otherwise
  perceptionBlock: 447, // measured 406
  runModeBlock: 436, // measured 396 in a group thread; 126 in a home thread
  subagentBlock: 356, // measured 324; 303 in a home thread
  toolCatalogBlock: 348, // measured 316 in C (12 pinned MCP tools), 287 in G (71 tools, text budget); 0 without
  workspaceInstructionsBlock: 114, // measured 103 (C only)
  skillCatalogBlock: 839, // measured 762 in C (12 skills); 426 with the built-ins alone
  threadSystemPromptBlock: 102, // measured 92 (C only)
};

/** Per case: system prompt, tools array, tail, and all three together. */
const CASE_CEILINGS: Record<
  CaseName,
  { system: number; toolsArray: number; tail: number; total: number }
> = {
  A: { system: 4627, toolsArray: 16314, tail: 156, total: 21096 }, // measured 4206 / 14831 / 141 / 19178
  B: { system: 5068, toolsArray: 16314, tail: 156, total: 21537 }, // measured 4607 / 14831 / 141 / 19579
  C: { system: 6040, toolsArray: 17027, tail: 226, total: 23293 }, // measured 5491 / 15479 / 205 / 21175
  D: { system: 3478, toolsArray: 13808, tail: 156, total: 17442 }, // measured 3162 / 12553 / 141 / 15856
  E: { system: 4721, toolsArray: 15872, tail: 96, total: 20689 }, // measured 4292 / 14429 / 87 / 18808
  F: { system: 5020, toolsArray: 16113, tail: 156, total: 21288 }, // measured 4564 / 14648 / 141 / 19353
  G: { system: 5347, toolsArray: 24758, tail: 156, total: 30260 }, // measured 4861 / 22507 / 141 / 27509
};

const MEASURED = new Map<string, Measured>();

/** One row per block, one column per case; then the per-case totals. */
function report(): string {
  const names = [...MEASURED.keys()];
  const row = (label: string, cells: Array<number | string>) =>
    `${label.padEnd(28)}${cells.map((c) => String(c).padStart(8)).join('')}`;
  const lines = [row('tokens', names)];
  for (const [block] of BLOCKS)
    lines.push(
      row(
        block,
        names.map((n) => MEASURED.get(n)!.blocks[block]!)
      )
    );
  for (const key of ['system', 'toolsArray', 'tail', 'total'] as const) {
    lines.push(
      row(
        key,
        names.map((n) => MEASURED.get(n)![key])
      )
    );
  }
  return lines.join('\n');
}

beforeAll(async () => {
  for (const [name, c] of Object.entries(cases())) MEASURED.set(name, await measure(c));
  if (process.env.PROMPT_TOKEN_REPORT === '1') console.log(report());
});

describe('prompt token budget for representative agents', () => {
  test.each(CASE_NAMES)('case %s stays within its totals', (name) => {
    const m = MEASURED.get(name)!;
    const ceiling = CASE_CEILINGS[name];
    expect(m.system).toBeLessThanOrEqual(ceiling.system);
    expect(m.toolsArray).toBeLessThanOrEqual(ceiling.toolsArray);
    expect(m.tail).toBeLessThanOrEqual(ceiling.tail);
    expect(m.total).toBeLessThanOrEqual(ceiling.total);
  });

  test.each(BLOCKS.map(([name]) => name))('%s stays within its ceiling in every case', (block) => {
    for (const m of MEASURED.values()) {
      expect({ block, tokens: m.blocks[block]! <= BLOCK_CEILINGS[block]! }).toEqual({
        block,
        tokens: true,
      });
    }
  });

  test('the measured blocks are exactly what composeSystemPrompt sends', async () => {
    for (const [name, c] of Object.entries(cases())) {
      mockInstructions = c.instructions;
      mockEmbeddings = c.ctx.embeddingsEnabled === true;
      const composed = await composeSystemPrompt(c.ctx);
      const sent = composed.reduce((sum, block) => sum + tokens(block.text), 0);
      expect({ name, sent }).toEqual({ name, sent: MEASURED.get(name)!.system });
    }
  });
});
