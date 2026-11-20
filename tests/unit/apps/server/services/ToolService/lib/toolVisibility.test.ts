/**
 * The headless gate: calls an agent makes with nobody to ask
 * (/api/tools/execute, the executor-level action gateway) get the same
 * visibility chat applies, and a tool the agent cannot see is refused rather
 * than escalated. Pure: no DB.
 */
import type { ToolRow } from '@snaglet/db/tables/tools';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import {
  bareDenyEntryFor,
  evaluateHeadlessToolCall,
  isToolVisible,
} from '@server/services/ToolService/lib/toolVisibility';

function tool(id: string, extra: Partial<ToolRow> = {}): ToolRow {
  return {
    id,
    name: id,
    description: id,
    type: 'builtin',
    parametersSchema: {},
    keywords: [],
    aliases: [],
    source: null,
    configJson: {},
    enabled: true,
    tier: 'standard',
    categoryPath: 'test',
    providerId: null,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
    ...extra,
  } as ToolRow;
}

// Unguarded: no command, path or SQL rule can name them.
const NOTE = tool('note_tool');
const OTHER = tool('other_tool');
const MEMORY = tool('memory', {
  parametersSchema: {
    type: 'object',
    properties: { op: { type: 'string', enum: ['create', 'delete'] } },
  },
});
const ACTIVE = new Set(['note_tool', 'other_tool', 'memory', 'tool', 'action']);

const access = (partial: Partial<ToolAccessConfig>): ToolAccessConfig => ({
  mode: 'all',
  allowList: [],
  denyList: [],
  ...partial,
});
const gate = (
  a: ToolAccessConfig,
  row: ToolRow,
  input: Record<string, unknown> = {},
  helper = false
) => evaluateHeadlessToolCall(a, row, input, { activeToolIds: ACTIVE, helper });

describe('evaluateHeadlessToolCall', () => {
  it('refuses an allow-list agent an unguarded tool its list does not name', () => {
    const verdict = gate(access({ mode: 'allow_list', allowList: ['other_tool'] }), NOTE);
    expect(verdict).toEqual({
      decision: 'deny',
      reason: "`note_tool` is not in this agent's tool list.",
    });
  });

  it('allows a listed tool', () => {
    expect(gate(access({ mode: 'allow_list', allowList: ['note_tool'] }), NOTE).decision).toBe(
      'allow'
    );
  });

  it("keeps a deny-list agent's bare and op denies, with the rule as the reason", () => {
    const bare = gate(access({ mode: 'deny_list', denyList: ['note_tool'] }), NOTE);
    expect(bare.decision).toBe('deny');
    expect(bare.reason).toContain('rule `note_tool`');
    expect(gate(access({ mode: 'deny_list', denyList: ['note_tool'] }), OTHER).decision).toBe(
      'allow'
    );
    const op = access({ mode: 'deny_list', denyList: ['memory_forget'] });
    expect(gate(op, MEMORY, { op: 'delete' }).decision).toBe('deny');
    expect(gate(op, MEMORY, { op: 'create' }).decision).toBe('allow');
  });

  it('leaves all mode unchanged', () => {
    expect(gate(access({ mode: 'all' }), NOTE).decision).toBe('allow');
    expect(gate(access({ mode: 'all' }), MEMORY, { op: 'delete' }).decision).toBe('allow');
  });

  it('keeps the platform primitives and the exempt subagent tool reachable', () => {
    const a = access({ mode: 'allow_list', allowList: ['other_tool'] });
    expect(gate(a, tool('tool')).decision).toBe('allow');
    expect(gate(a, tool('subagent')).decision).toBe('allow');
  });

  it('never gates the action router itself (its target is gated by the gateway)', () => {
    const a = access({ mode: 'allow_list', allowList: ['other_tool'] });
    expect(gate(a, tool('action'), { tool: 'note_tool' }).decision).toBe('allow');
    // A bare deny on action still holds.
    expect(gate(access({ mode: 'deny_list', denyList: ['action'] }), tool('action')).decision).toBe(
      'deny'
    );
  });

  it('refuses a subagent helper the helper-denied tools in every mode', () => {
    const verdict = gate(access({ mode: 'all' }), MEMORY, { op: 'create' }, true);
    expect(verdict).toEqual({
      decision: 'deny',
      reason: '`memory` is not available to a subagent helper.',
    });
  });

  it('judges a live MCP tool by server enablement, not the allow list', () => {
    const mcpTool = tool('mcp__test-server__lookup', { type: 'mcp' });
    const a = access({ mode: 'allow_list', allowList: ['other_tool'] });
    expect(isToolVisible(mcpTool, a, ACTIVE)).toBe(true);
    expect(gate(a, mcpTool).decision).toBe('allow');
    const denied = access({ mode: 'allow_list', allowList: [], denyList: [mcpTool.id] });
    expect(gate(denied, mcpTool).decision).toBe('deny');
  });

  it('still returns ask for a listed guarded tool whose input no rule covers', () => {
    const shell = tool('shell', { name: 'Shell' });
    const a = access({ mode: 'allow_list', allowList: ['shell(git:*)'] });
    expect(gate(a, shell, { op: 'run', cmd: 'rm -rf /tmp/a' }).decision).toBe('ask');
    expect(gate(a, shell, { op: 'run', cmd: 'git status' }).decision).toBe('allow');
  });
});

describe('bare denies hold in every mode, as chat dispatch reads them', () => {
  const SHELL = tool('shell', { name: 'Shell', aliases: ['terminal', 'bash'] });
  const TABLE = tool('table', {
    name: 'Table',
    aliases: ['table_read', 'table_write'],
    parametersSchema: {
      type: 'object',
      properties: { op: { type: 'string', enum: ['read', 'write'] } },
    },
  });
  const allMode = (...denyList: string[]) => access({ mode: 'all', denyList });

  it.each(['shell', 'Shell', 'SHELL', 'BASH', 'terminal'])(
    'All mode: a bare deny naming shell as %s refuses it, with the rule',
    (entry) => {
      expect(gate(allMode(entry), SHELL, { op: 'run', cmd: 'ls' })).toEqual({
        decision: 'deny',
        rule: entry,
        reason: `\`shell\` is denied for this agent (rule \`${entry}\`).`,
      });
    }
  );

  it('All mode: a rule, or an old id outside the definition names, does nothing', () => {
    const run = { op: 'run', cmd: 'rm -rf /tmp/a' };
    expect(gate(allMode('shell(rm:*)'), SHELL, run).decision).toBe('allow');
    expect(gate(allMode('exec_command'), SHELL, run).decision).toBe('allow');
    expect(gate(allMode('other_tool'), SHELL, run).decision).toBe('allow');
  });

  it('never denies search or the clock', () => {
    expect(bareDenyEntryFor(['tool'], tool('tool'))).toBeUndefined();
    expect(gate(allMode('tool'), tool('tool')).decision).toBe('allow');
  });

  it('an old id among the definition names denies the whole tool, as in chat', () => {
    const a = access({ mode: 'deny_list', denyList: ['table_read'] });
    expect(gate(a, TABLE, { op: 'write' }).decision).toBe('deny');
    expect(gate(allMode('table_read'), TABLE, { op: 'write' }).decision).toBe('deny');
  });
});

describe('doc history family visibility and headless access', () => {
  const row = tool('doc', {
    parametersSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['get', 'snapshot', 'list-snapshots', 'restore', 'delete-snapshot'],
        },
      },
    },
  });
  it('keeps doc visible when only history is denied', () => {
    expect(
      isToolVisible(row, access({ mode: 'deny_list', denyList: ['doc_history'] }), new Set(['doc']))
    ).toBe(true);
    expect(
      gate(access({ mode: 'deny_list', denyList: ['doc_history'] }), row, { op: 'get' }).decision
    ).toBe('allow');
    expect(
      gate(access({ mode: 'deny_list', denyList: ['doc_history'] }), row, { op: 'delete-snapshot' })
        .decision
    ).toBe('deny');
  });
  it('exposes doc for a history grant but never grants live-document deletion', () => {
    const a = access({ mode: 'allow_list', allowList: ['doc_history'] });
    expect(isToolVisible(row, a, new Set(['doc']))).toBe(true);
    expect(gate(a, row, { op: 'restore' }).decision).toBe('allow');
    expect(gate(a, row, { op: 'delete' }).decision).toBe('ask');
  });
});
