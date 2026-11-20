/**
 * Search fields that left the schema still work.
 *
 * Nothing validates input against `parameters_schema` (ToolExecutor passes
 * input through `normalizeToolParams` straight to the handler, and tools are
 * sent without `strict`), so a field leaving the schema keeps its behavior.
 * These tests pin that for every unlisted field — directly and through the
 * `database_search`, `workspace_list_archived` and `workspace_list_recent`
 * aliases — and pin that each one stays discoverable (get_tool_schema's
 * `unlisted_parameters` and TOOL.md).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const handlers = {
  workspace: jest.fn().mockResolvedValue('workspace'),
  database: jest.fn().mockResolvedValue('database'),
  conversations: jest.fn().mockResolvedValue('conversations'),
  archived: jest.fn().mockResolvedValue({ results: ['archived'] }),
  recent: jest.fn().mockResolvedValue('recent'),
};

jest.mock('@server/services/ToolService/handlers/search/workspaceSearch/workspaceSearch', () => ({
  __esModule: true,
  default: handlers.workspace,
}));
jest.mock('@server/services/ToolService/handlers/search/databaseSearch', () => ({
  __esModule: true,
  default: handlers.database,
}));
jest.mock('@server/services/ToolService/handlers/search/findConversation/findConversation', () => ({
  __esModule: true,
  default: handlers.conversations,
}));
jest.mock('@server/services/ToolService/handlers/search/listArchived', () => ({
  __esModule: true,
  default: handlers.archived,
}));
jest.mock('@server/services/ToolService/handlers/search/listRecent', () => ({
  __esModule: true,
  default: handlers.recent,
}));

import { resolveToolId, transformToolAliasParams } from '@snaglet/shared/utils';
import search from '@server/services/ToolService/tools/workspace/search/tool';
import definition from '@server/services/ToolService/tools/workspace/search/definition';
import { projectTools } from '@server/domains/mcp/mcpProjection';
import { toolDefinitionToCreateInput } from '@server/services/ToolService/lib/syncToolCatalog';
import type { ToolDefinition } from '@server/services/ToolService/types';

const settings = { root_dir: '/repo' };
const context = { agentId: 'agent-1' } as never;

/** Unlisted in-app and kept app-local: never in the external MCP schema. */
const APP_LOCAL = [
  'graph_depth',
  'thread_id',
  'archived_only',
  'since',
  'container_path',
  'table',
  'columns',
  'search_columns',
  'filters',
  'order_by',
  'order_direction',
  'match_tables',
  'offset',
];

/** Unlisted in-app only to save agent tokens: still published to MCP clients. */
const PUBLISHED = [
  'include_archived',
  'container_id',
  'name',
  'scope_files',
  'project_id',
  'code_mode',
  'glob',
];

const UNLISTED = [...APP_LOCAL, ...PUBLISHED];

const DATABASE_FIELDS = {
  table: 'snaglet_backlog',
  columns: ['id', 'name'],
  search_columns: ['name'],
  filters: { status: 'Done' },
  order_by: 'name',
  order_direction: 'desc',
  offset: 20,
};

/** Resolve an alias the way ToolExecutor does: pinned params win, renames apply. */
function viaAlias(aliasId: string, params: Record<string, unknown>) {
  const resolution = resolveToolId(aliasId);
  expect(resolution.id).toBe('search');
  return transformToolAliasParams(resolution, params);
}

beforeEach(() => jest.clearAllMocks());

describe('search tool placement', () => {
  const repoRoot = path.join(__dirname, '../../../../../../../..');

  it('lives under tools/workspace/search, so its category is workspace, not uncategorized', () => {
    const registry = readFileSync(
      path.join(
        repoRoot,
        'apps/server/src/services/ToolService/generated/registry-source.static.ts'
      ),
      'utf8'
    );
    const line = registry.split('\n').find((l) => l.includes('toolId: "search",'));
    expect(line).toContain('categoryPath: "workspace"');
    expect(definition.id).toBe('search');
  });
});

describe('search unlisted params — schema and discovery', () => {
  const properties = (definition.parameters_schema as { properties: Record<string, unknown> })
    .properties;
  const unlisted = definition.unlisted_params ?? {};
  const toolMd = readFileSync(
    path.join(
      __dirname,
      '../../../../../../../../apps/server/src/services/ToolService/tools/workspace/search/TOOL.md'
    ),
    'utf8'
  );

  it.each(UNLISTED)('%s is not in the advertised schema', (field) => {
    expect(properties).not.toHaveProperty(field);
  });

  it.each(UNLISTED)('%s keeps a schema in unlisted_params', (field) => {
    expect(unlisted[field]).toEqual(
      expect.objectContaining({
        type: expect.anything(), // a type name, or a list of them (filters is an array or an object)
        description: expect.any(String),
      })
    );
  });

  it.each(UNLISTED)('%s is documented in TOOL.md by its exact name', (field) => {
    expect(toolMd).toContain(`\`${field}\``);
  });

  it('unlisted_params has exactly the hidden fields (nothing listed twice)', () => {
    expect(Object.keys(unlisted).sort()).toEqual([...UNLISTED].sort());
    for (const field of Object.keys(unlisted)) expect(properties).not.toHaveProperty(field);
  });

  it('unlisted params never reach the DB row or the MCP projection', () => {
    const def = { ...definition, categoryPath: 'workspace' } as ToolDefinition;
    const created = JSON.stringify(toolDefinitionToCreateInput(def));
    expect(created).not.toContain('unlisted_params');
    expect(created).not.toContain('graph_depth');
    const [snagletSearch] = projectTools({ search: def });
    expect(snagletSearch.name).toBe('snaglet_search');
    expect(JSON.stringify(snagletSearch)).not.toContain('unlisted_params');
    const mcpProps = (snagletSearch.inputSchema as { properties: Record<string, unknown> })
      .properties;
    for (const field of APP_LOCAL) expect(mcpProps).not.toHaveProperty(field);
  });

  it('publishes the token-saving unlisted fields to MCP clients, verbatim', () => {
    const def = { ...definition, categoryPath: 'workspace' } as ToolDefinition;
    const [snagletSearch] = projectTools({ search: def });
    const mcpProps = (snagletSearch.inputSchema as { properties: Record<string, unknown> })
      .properties;
    for (const field of PUBLISHED) expect(mcpProps[field]).toEqual(unlisted[field]);
    for (const field of Object.keys(properties)) expect(mcpProps).toHaveProperty(field);
  });

  it('points at tool op:schema for the unlisted fields', () => {
    expect(definition.description).toContain('tool({op:"schema", name:"search"})');
    expect(definition.description).toContain('unlisted_parameters');
  });

  it('lists project_scope in the advertised schema, and says where it applies', () => {
    expect(properties).toHaveProperty('project_scope');
    const scope = properties.project_scope as { enum: string[]; description: string };
    expect(scope.enum).toEqual(['prioritize', 'only', 'all']);
    expect(scope.description).toContain('only');
    expect(unlisted).not.toHaveProperty('project_scope');
    expect(toolMd).toContain('`project_scope`');
  });

  it('states the real mode default (hybrid), not keyword', () => {
    expect(definition.description).toContain('`mode` defaults to `hybrid`');
    expect(definition.description).not.toContain('default keyword');
    expect(toolMd).toContain('`mode` defaults to `hybrid`');
  });

  it('keeps the date phrases agents rely on', () => {
    const timeRange = JSON.stringify(properties.time_range);
    for (const phrase of [
      'yesterday',
      'last week',
      'in q3',
      'created yesterday',
      'updated last week',
      'recently',
      'lately',
      '30 days',
    ]) {
      expect(timeRange).toContain(phrase);
    }
  });
});

describe('search unlisted params — still reach the handler', () => {
  it.each([
    ['graph_depth', { graph_depth: 1 }],
    ['thread_id', { thread_id: 'thread-1' }],
    ['container_id', { container_id: 'container-1' }],
    ['name', { name: 'docs' }],
    ['include_archived', { include_archived: true }],
    ['scope_files', { scope_files: 'workspace', project_id: 'container-2' }],
  ])('%s reaches workspace search unchanged', async (_field, extra) => {
    const input = { query: 'needle', mode: 'hybrid', ...extra };
    await expect(search(input, settings, context)).resolves.toBe('workspace');
    expect(handlers.workspace).toHaveBeenCalledWith(input, settings, context);
  });

  it('project_scope reaches workspace search unchanged', async () => {
    const input = { query: 'retry', mode: 'hybrid', project_scope: 'only' };
    await expect(search(input, settings, context)).resolves.toBe('workspace');
    expect(handlers.workspace).toHaveBeenCalledWith(input, settings, context);
  });

  it('project_scope reaches conversation search unchanged', async () => {
    const input = { kind: 'conversations', query: 'retry', project_scope: 'only' };
    await expect(search(input, settings, context)).resolves.toBe('conversations');
    expect(handlers.conversations).toHaveBeenCalledWith(input, settings, context);
  });

  it('archived_only routes to the archived list', async () => {
    await search({ archived_only: true, kinds: ['doc'], limit: 4 }, settings, context);
    expect(handlers.archived).toHaveBeenCalledWith({ limit: 4, type: 'doc' });
    expect(handlers.workspace).not.toHaveBeenCalled();
  });

  it('since and container_path reach the recent list unchanged', async () => {
    const input = {
      sort: 'recent',
      since: '2026-10-01T00:00:00Z',
      container_path: '/Snaglet/docs',
    };
    await expect(search(input, settings, context)).resolves.toBe('recent');
    expect(handlers.recent).toHaveBeenCalledWith(input, settings, context);
  });

  it('every database field reaches database search unchanged', async () => {
    const input = { kind: 'database', query: 'cache', ...DATABASE_FIELDS };
    await expect(search(input, settings, context)).resolves.toBe('database');
    expect(handlers.database).toHaveBeenCalledWith(input, settings, context);
  });
});

describe('search unlisted params — through the aliases', () => {
  it('database_search pins kind and passes every database field through', async () => {
    const input = viaAlias('database_search', { query: 'cache', ...DATABASE_FIELDS });
    expect(input).toEqual({ kind: 'database', query: 'cache', ...DATABASE_FIELDS });
    await expect(search(input, settings, context)).resolves.toBe('database');
    expect(handlers.database).toHaveBeenCalledWith(input, settings, context);
  });

  it('workspace_list_archived pins archived_only and maps type -> kinds', async () => {
    const input = viaAlias('workspace_list_archived', { type: 'container', limit: 3 });
    expect(input).toEqual(
      expect.objectContaining({ archived_only: true, kinds: ['container'], limit: 3 })
    );
    await search(input, settings, context);
    expect(handlers.archived).toHaveBeenCalledWith({ limit: 3, type: 'container' });
  });

  it('workspace_list_recent pins sort and keeps since/container_path', async () => {
    const input = viaAlias('workspace_list_recent', {
      since: '2026-10-01T00:00:00Z',
      container_path: '/Snaglet',
    });
    expect(input).toEqual(
      expect.objectContaining({
        sort: 'recent',
        since: '2026-10-01T00:00:00Z',
        container_path: '/Snaglet',
      })
    );
    await expect(search(input, settings, context)).resolves.toBe('recent');
    expect(handlers.recent).toHaveBeenCalledWith(input, settings, context);
  });
});
