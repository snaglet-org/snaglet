/**
 * Subagent narrowing reads entries the way the permission engine does: a
 * tool's id, its display name (exactly on the allow side, in
 * any case on the deny side), and an old id through the alias map with its
 * pins. Every case also holds the safety rule: a helper never ends up with
 * more than its orchestrator has, and anything unprovable narrows.
 */
import { describe, expect, it } from '@jest/globals';
import {
  accessAllowsTool,
  EMPTY_TOOL_NAME_CATALOG,
  helperMcpLimit,
  helperToolAccess,
  narrowToolAccess,
  type ToolNameCatalog,
} from '@server/services/subagents/toolAccess';
import { SubagentError } from '@server/services/subagents/errors';
import { isToolVisible } from '@server/services/ToolService/lib/toolVisibility';
import { evaluateToolPermission } from '@server/services/ToolService/lib/toolPermission';
import type { ToolAccessConfig } from '@snaglet/shared/types';

const TOOLS = [
  { id: 'shell', name: 'Shell', aliases: ['bash'] },
  { id: 'web_fetch', name: 'Fetch URL', aliases: [] },
  { id: 'git', name: 'Git', aliases: [] },
  { id: 'doc', name: 'Doc', aliases: [] },
  { id: 'search', name: 'Search', aliases: [] },
  { id: 'memory', name: 'Memory', aliases: [] },
  { id: 'subagent', name: 'Subagent', aliases: [] },
];
const CATALOG: ToolNameCatalog = {
  activeToolIds: new Set(TOOLS.map((t) => t.id)),
  tools: TOOLS,
};

function allow(allowList: string[], denyList: string[] = []): ToolAccessConfig {
  return { mode: 'allow_list', allowList, denyList };
}
function deny(denyList: string[]): ToolAccessConfig {
  return { mode: 'deny_list', allowList: [], denyList };
}
const ALL: ToolAccessConfig = { mode: 'all', allowList: [], denyList: [] };

/** Whether the helper with `access` sees `toolId`, as the resolver decides it. */
function visible(access: ToolAccessConfig, toolId: string): boolean {
  const tool = TOOLS.find((t) => t.id === toolId)!;
  return isToolVisible(
    { ...tool, type: 'builtin', parametersSchema: null },
    access,
    CATALOG.activeToolIds,
    { helper: true }
  );
}

describe('narrowing by display name', () => {
  it('a helper listing the id gets a tool the orchestrator allows by display name', () => {
    const narrowed = narrowToolAccess(
      allow(['Fetch URL', 'search']),
      allow(['web_fetch']),
      CATALOG
    );
    expect(narrowed.allowList).toEqual(['Fetch URL']);
    expect(visible(narrowed, 'web_fetch')).toBe(true);
    expect(visible(narrowed, 'shell')).toBe(false);
  });

  it('a helper listing the display name gets a tool the orchestrator allows by id', () => {
    const narrowed = narrowToolAccess(allow(['web_fetch', 'shell']), allow(['Fetch URL']), CATALOG);
    expect(narrowed.allowList).toEqual(['web_fetch']);
    expect(visible(narrowed, 'web_fetch')).toBe(true);
    expect(visible(narrowed, 'shell')).toBe(false);
  });

  it('an allow-side display name must match exactly, as it does for every agent', () => {
    const narrowed = narrowToolAccess(allow(['web_fetch']), allow(['fetch url']), CATALOG);
    expect(narrowed.allowList).toEqual([]);
    expect(visible(narrowed, 'web_fetch')).toBe(false);
  });

  it('an orchestrator deny by display name, in any case, removes the listed tool', () => {
    const narrowed = narrowToolAccess(deny(['SHELL']), allow(['shell', 'search']), CATALOG);
    expect(narrowed.allowList).toEqual(['search']);
    expect(narrowed.denyList).toEqual(['SHELL']);
    expect(visible(narrowed, 'shell')).toBe(false);
  });

  it('a deny by definition name (bash) removes shell too', () => {
    expect(narrowToolAccess(deny(['bash']), allow(['Shell']), CATALOG).allowList).toEqual([]);
  });

  it('keeps the orchestrator specifier when the helper lists the tool by name', () => {
    const narrowed = narrowToolAccess(allow(['shell(git:*)']), allow(['Shell']), CATALOG);
    expect(narrowed.allowList).toEqual(['shell(git:*)']);
    const verdict = evaluateToolPermission(
      narrowed,
      'shell',
      { op: 'run', command: 'rm -rf x' },
      { activeToolIds: CATALOG.activeToolIds }
    );
    expect(verdict.decision).not.toBe('allow');
  });

  it('keeps a helper specifier inside a tool-wide orchestrator entry', () => {
    expect(narrowToolAccess(allow(['Shell']), allow(['shell(git:*)']), CATALOG).allowList).toEqual([
      'shell(git:*)',
    ]);
  });

  it('an orchestrator display name never names a tool for a deny-list base', () => {
    // The helper's own entries are kept as written against an All or deny-list
    // base; the engine reads `Fetch URL` as web_fetch.
    const narrowed = narrowToolAccess(ALL, allow(['Fetch URL']), CATALOG);
    expect(narrowed.allowList).toEqual(['Fetch URL']);
    expect(visible(narrowed, 'web_fetch')).toBe(true);
  });
});

describe('narrowing by old id (alias map, with pins)', () => {
  it('a helper listing an old id gets only that op of a tool-wide orchestrator entry', () => {
    const narrowed = narrowToolAccess(allow(['git', 'doc']), allow(['git_status']), CATALOG);
    expect(narrowed.allowList).toEqual(['git_status']);
    const options = { activeToolIds: CATALOG.activeToolIds };
    expect(
      evaluateToolPermission(narrowed, 'git', { subcommand: 'status' }, options).decision
    ).toBe('allow');
    expect(
      evaluateToolPermission(narrowed, 'git', { subcommand: 'push' }, options).decision
    ).not.toBe('allow');
  });

  it('an orchestrator old id stays pinned when the helper lists the whole tool', () => {
    const narrowed = narrowToolAccess(allow(['get_doc']), allow(['doc']), CATALOG);
    expect(narrowed.allowList).toEqual(['get_doc']);
  });

  it('two different ops of one tool keep neither (cannot prove either is within the other)', () => {
    const narrowed = narrowToolAccess(allow(['git_push']), allow(['git_status']), CATALOG);
    expect(narrowed.allowList).toEqual([]);
  });

  it('the same old id on both sides is kept', () => {
    expect(narrowToolAccess(allow(['get_doc']), allow(['get_doc']), CATALOG).allowList).toEqual([
      'get_doc',
    ]);
  });

  it('an op-scoped orchestrator deny does not remove the whole tool from the list', () => {
    const narrowed = narrowToolAccess(
      deny(['memory_forget']),
      allow(['memory', 'search']),
      CATALOG
    );
    expect(narrowed.allowList).toEqual(['memory', 'search']);
    expect(narrowed.denyList).toEqual(['memory_forget']);
  });

  it('reads old ids through the static alias map even with no catalog', () => {
    expect(
      narrowToolAccess(allow(['git']), allow(['git_status']), EMPTY_TOOL_NAME_CATALOG).allowList
    ).toEqual(['git_status']);
  });
});

describe('never wider than the orchestrator', () => {
  const bases: ToolAccessConfig[] = [
    allow(['Fetch URL', 'shell(git:*)', 'get_doc']),
    allow(['search'], ['web_fetch']),
    deny(['SHELL', 'memory_forget']),
    ALL,
  ];
  const owns: ToolAccessConfig[] = [
    allow(['web_fetch', 'shell', 'doc', 'git']),
    allow(['Shell', 'Fetch URL', 'search']),
    allow(['git_status', 'delete_doc']),
  ];

  it('every tool a narrowed helper sees, its orchestrator and its own list both allow', () => {
    for (const base of bases) {
      for (const own of owns) {
        const narrowed = narrowToolAccess(base, own, CATALOG);
        for (const tool of TOOLS) {
          if (visible(narrowed, tool.id)) {
            expect([tool.id, visible(base, tool.id)]).toEqual([tool.id, true]);
            expect([tool.id, visible(own, tool.id)]).toEqual([tool.id, true]);
          }
        }
        expect(narrowed.denyList).toEqual(expect.arrayContaining(base.denyList));
      }
    }
  });
});

describe('the start-time check', () => {
  it('accepts a listed id the orchestrator allows by display name, as written', () => {
    expect(
      helperToolAccess(allow(['Fetch URL']), ['web_fetch'], { catalog: CATALOG })
        .toolAccessAllowList
    ).toEqual(['web_fetch']);
  });

  it('refuses a listed tool only a pinned old id of the orchestrator could allow differently', () => {
    expect(() =>
      helperToolAccess(allow(['git_push']), ['git_status'], { catalog: CATALOG })
    ).toThrow(SubagentError);
  });

  it('drops a helper-denied tool named by display name or old id', () => {
    expect(
      helperToolAccess(ALL, ['Subagent', 'memory_save', 'search'], { catalog: CATALOG })
        .toolAccessAllowList
    ).toEqual(['search']);
  });

  it('drops a tool the orchestrator denies by display name', () => {
    expect(
      helperToolAccess(deny(['fetch url']), ['web_fetch', 'search'], { catalog: CATALOG })
        .toolAccessAllowList
    ).toEqual(['search']);
  });
});

describe('MCP tools in a narrowing', () => {
  const MCP = 'mcp__test-server-a__list_issues';
  const OTHER = 'mcp__test-server-b__create_issue';

  it('keeps a listed MCP tool only from a server the orchestrator has', () => {
    expect(
      helperToolAccess(allow(['search']), [MCP, OTHER, 'search'], {
        catalog: CATALOG,
        mcpServerIds: ['test-server-a'],
      }).toolAccessAllowList
    ).toEqual([MCP, 'search']);
    expect(() =>
      helperToolAccess(ALL, [OTHER], { catalog: CATALOG, mcpServerIds: ['test-server-a'] })
    ).toThrow(SubagentError);
  });

  it('refuses a listed MCP tool the orchestrator denies', () => {
    expect(() =>
      helperToolAccess(deny([MCP]), [MCP], { catalog: CATALOG, mcpServerIds: ['test-server-a'] })
    ).toThrow(SubagentError);
  });

  it('passes listed MCP ids through an orchestrator allow list (MCP is gated by servers)', () => {
    expect(narrowToolAccess(allow(['search']), allow([MCP, 'search']), CATALOG).allowList).toEqual([
      'search',
      MCP,
    ]);
  });

  it('limits the helper to the MCP ids it lists, exactly; no limit without a narrowing', () => {
    expect([...(helperMcpLimit(allow([MCP, 'list_issues', 'search'])) ?? [])]).toEqual([MCP]);
    expect(helperMcpLimit(ALL)).toBeNull();
    expect(helperMcpLimit(deny(['shell']))).toBeNull();
  });
});

describe('whether the orchestrator already has a tool (grant target)', () => {
  it('reads a display name on either side', () => {
    expect(accessAllowsTool(allow(['Fetch URL']), 'web_fetch', CATALOG)).toBe(true);
    expect(accessAllowsTool(deny(['fetch url']), 'web_fetch', CATALOG)).toBe(false);
  });

  it('an old id that allows one op is not the whole tool', () => {
    expect(accessAllowsTool(allow(['git_status']), 'git', CATALOG)).toBe(false);
    expect(accessAllowsTool(deny(['memory_forget']), 'memory', CATALOG)).toBe(true);
  });
});

describe('doc history family narrowing', () => {
  it('retains a single history op within the family in either intersection order', () => {
    expect(
      narrowToolAccess(allow(['doc_history']), allow(['snapshot_doc']), CATALOG).allowList
    ).toEqual(['snapshot_doc']);
    expect(
      narrowToolAccess(allow(['snapshot_doc']), allow(['doc_history']), CATALOG).allowList
    ).toEqual(['snapshot_doc']);
  });
  it('never widens a history grant to all doc operations', () => {
    expect(narrowToolAccess(allow(['doc_history']), allow(['doc']), CATALOG).allowList).toEqual([
      'doc_history',
    ]);
    expect(
      narrowToolAccess(allow(['doc_history']), allow(['delete_doc']), CATALOG).allowList
    ).toEqual([]);
  });
  it('keeps non-history doc access when history is denied', () => {
    const result = narrowToolAccess(deny(['doc_history']), allow(['doc']), CATALOG);
    expect(result.allowList).toEqual(['doc']);
    expect(result.denyList).toContain('doc_history');
  });
});
