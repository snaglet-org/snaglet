/**
 * audit-tool-registry — handler-import validation. The audit imports each
 * tool.ts rather than reading it as text: the runtime loader
 * (registry-source.ts) only warns and skips a tool.ts that fails to import, so
 * the audit is what surfaces that failure. These tests build a tmpdir fixture
 * with a deliberately broken tool.ts and assert auditEntries() reports it,
 * while a valid handler passes clean.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  auditDestructiveOps,
  auditAliasTargets,
  auditEntries,
} from '@server/services/ToolService/scripts/audit-tool-registry';
import { TOOL_ALIASES } from '@snaglet/shared/utils';
import {
  listToolFolders,
  type ToolFolderEntry,
} from '@server/services/ToolService/scripts/lib/tool-metadata';

function makeEntry(absPath: string, folderName: string): ToolFolderEntry {
  return {
    folderName,
    toolId: folderName.replace(/-/g, '_'),
    categoryPath: 'uncategorized',
    relativePath: folderName,
    absPath,
  };
}

function writeValidDefinition(dir: string, id: string): void {
  writeFileSync(
    path.join(dir, 'definition.ts'),
    [
      "import type { BuiltinToolDefinition } from '@server/services/ToolService/types';",
      '',
      `const definition: BuiltinToolDefinition = {`,
      `  id: '${id}',`,
      `  name: '${id}',`,
      `  description: 'fixture tool for audit-tool-registry tests',`,
      `  type: 'builtin',`,
      `  tier: 'standard',`,
      `  keywords: ['fixture'],`,
      `  parameters_schema: { type: 'object', properties: {} },`,
      `};`,
      '',
      'export default definition;',
      '',
    ].join('\n')
  );
}

describe('audit-tool-registry — handler import validation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'audit-tool-registry-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports a tool.ts that fails to import — not a silent skip', async () => {
    const dir = path.join(tmpDir, 'broken-tool');
    mkdirSync(dir, { recursive: true });
    writeValidDefinition(dir, 'broken_tool');
    // Deliberately broken: throws during module evaluation, so the dynamic
    // import() itself rejects — the same failure mode a real corrupted
    // handler would hit at runtime under registry-source.ts's loader.
    writeFileSync(
      dir + '/tool.ts',
      "throw new Error('deliberately broken handler — audit fixture');\n" +
        'export default async function brokenTool() { return "unreachable"; }\n'
    );

    const issues = await auditEntries([makeEntry(dir, 'broken-tool')]);

    const handlerIssues = issues.filter((issue) => issue.kind === 'handler_failed');
    expect(handlerIssues).toHaveLength(1);
    expect(handlerIssues[0].toolId).toBe('broken_tool');
    expect(handlerIssues[0].reason).toContain('deliberately broken handler');
  });

  it('reports a tool.ts with no function default export — not a silent skip', async () => {
    const dir = path.join(tmpDir, 'not-a-function-tool');
    mkdirSync(dir, { recursive: true });
    writeValidDefinition(dir, 'not_a_function_tool');
    // Imports fine, but the default export isn't callable — registry-source
    // treats this the same as an import failure (skip + warn), so the audit
    // must too.
    writeFileSync(dir + '/tool.ts', 'export default { not: "a function" };\n');

    const issues = await auditEntries([makeEntry(dir, 'not-a-function-tool')]);

    const handlerIssues = issues.filter((issue) => issue.kind === 'handler_failed');
    expect(handlerIssues).toHaveLength(1);
    expect(handlerIssues[0].reason).toMatch(/no default export function/);
  });

  it('does not flag a tool with a valid handler and valid definition', async () => {
    const dir = path.join(tmpDir, 'valid-tool');
    mkdirSync(dir, { recursive: true });
    writeValidDefinition(dir, 'valid_tool');
    writeFileSync(dir + '/tool.ts', 'export default async function validTool() { return "ok"; }\n');

    const issues = await auditEntries([makeEntry(dir, 'valid-tool')]);

    expect(issues).toHaveLength(0);
  });

  it('reports a folder id that differs from its definition id', async () => {
    const dir = path.join(tmpDir, 'folder-name');
    mkdirSync(dir, { recursive: true });
    writeValidDefinition(dir, 'different_id');
    writeFileSync(dir + '/tool.ts', 'export default async function validTool() { return "ok"; }\n');

    const issues = await auditEntries([makeEntry(dir, 'folder-name')]);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'definition_id_mismatch',
          toolId: 'different_id',
        }),
      ])
    );
  });

  it('reports aliases whose canonical target is not registered', () => {
    const registered = new Set(
      Object.values(TOOL_ALIASES)
        .filter(({ removed }) => !removed)
        .map(({ id }) => id)
    );
    registered.delete('search');

    const issues = auditAliasTargets(registered);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'dangling_alias',
          toolId: 'workspace_search',
        }),
      ])
    );
  });

  it('reports an unrecognized contextRequirement value — the panel picker is driven by this enum', async () => {
    const dir = path.join(tmpDir, 'bad-context-tool');
    mkdirSync(dir, { recursive: true });
    // tsx strips types (no typecheck at import time), so a bad enum literal
    // would otherwise sail straight into the registry and silently break the
    // panel's declarative act-as/confirm behavior. The audit is the gate.
    writeFileSync(
      path.join(dir, 'definition.ts'),
      [
        'const definition = {',
        "  id: 'bad_context_tool',",
        "  name: 'bad_context_tool',",
        "  description: 'fixture tool with invalid execution metadata',",
        "  type: 'builtin',",
        "  tier: 'standard',",
        "  keywords: ['fixture'],",
        '  parameters_schema: { type: "object", properties: {} },',
        "  contextRequirement: 'sometimes',",
        '};',
        '',
        'export default definition;',
        '',
      ].join('\n')
    );
    writeFileSync(
      dir + '/tool.ts',
      'export default async function badCtxTool() { return "ok"; }\n'
    );

    const issues = await auditEntries([makeEntry(dir, 'bad-context-tool')]);

    const metaIssues = issues.filter((issue) => issue.kind === 'invalid_execution_metadata');
    expect(metaIssues).toHaveLength(1);
    expect(metaIssues[0].toolId).toBe('bad_context_tool');
    expect(metaIssues[0].reason).toContain('sometimes');
  });

  it('accepts valid execution metadata (contextRequirement enum + boolean flags)', async () => {
    const dir = path.join(tmpDir, 'good-meta-tool');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'definition.ts'),
      [
        "import type { BuiltinToolDefinition } from '@server/services/ToolService/types';",
        '',
        'const definition: BuiltinToolDefinition = {',
        "  id: 'good_meta_tool',",
        "  name: 'good_meta_tool',",
        "  description: 'fixture tool with valid execution metadata',",
        "  type: 'builtin',",
        "  tier: 'standard',",
        "  keywords: ['fixture'],",
        '  parameters_schema: { type: "object", properties: {} },',
        "  contextRequirement: 'agent-required',",
        '  destructive: true,',
        '};',
        '',
        'export default definition;',
        '',
      ].join('\n')
    );
    writeFileSync(
      dir + '/tool.ts',
      'export default async function goodMetaTool() { return "ok"; }\n'
    );

    const issues = await auditEntries([makeEntry(dir, 'good-meta-tool')]);

    expect(issues).toHaveLength(0);
  });

  it('the real registry has zero issues with handler-import validation on', async () => {
    const entries = listToolFolders();
    const issues = await auditEntries(entries);

    if (issues.length > 0) {
      // Surface exactly what's broken in the failure output rather than a
      // bare "expected [] to equal [...]" dump.
      throw new Error(
        `tool-registry audit found ${issues.length} issue(s):\n` +
          issues.map((issue) => `  ${issue.kind} ${issue.path}: ${issue.reason}`).join('\n')
      );
    }
    expect(issues).toEqual([]);
  }, 120_000);
});

describe('audit-tool-registry — per-op destructiveness (strict)', () => {
  const schema = (ops?: string[]) =>
    ops ? { type: 'object', properties: { op: { type: 'string', enum: ops } } } : {};
  const reasons = (...args: Parameters<typeof auditDestructiveOps>) =>
    auditDestructiveOps(...args).map((issue) => issue.reason);

  it('accepts destructiveOps that name ops in the enum', () => {
    expect(reasons('p', 't', schema(['get', 'delete']), undefined, ['delete'])).toEqual([]);
  });

  it('accepts whole-tool destructive on a tool without an op enum', () => {
    expect(reasons('p', 't', schema(), true, undefined)).toEqual([]);
  });

  it('rejects destructive: true on an op-enum tool (strict rule)', () => {
    expect(reasons('p', 't', schema(['get', 'delete']), true, undefined)).toEqual([
      expect.stringContaining('declare destructiveOps'),
    ]);
    expect(reasons('p', 't', schema(['get', 'delete']), true, ['delete'])).toHaveLength(1);
  });

  it('rejects ops missing from the enum, non-string lists, and op-less tools', () => {
    expect(reasons('p', 't', schema(['get']), undefined, ['delete'])).toEqual([
      expect.stringContaining('"delete"'),
    ]);
    expect(reasons('p', 't', schema(['get']), undefined, 'delete')).toHaveLength(1);
    expect(reasons('p', 't', schema(), undefined, ['delete'])).toEqual([
      expect.stringContaining('without an `op` enum'),
    ]);
  });
});
