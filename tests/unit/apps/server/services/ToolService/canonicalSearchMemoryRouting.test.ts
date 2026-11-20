const searchHandlers = {
  workspace: jest.fn().mockResolvedValue('workspace'),
  docs: jest.fn().mockResolvedValue('docs'),
  containers: jest.fn().mockResolvedValue('containers'),
  code: jest.fn().mockResolvedValue('code'),
  files: jest.fn().mockResolvedValue('files'),
  database: jest.fn().mockResolvedValue('database'),
  conversations: jest.fn().mockResolvedValue('conversations'),
  archived: jest.fn().mockResolvedValue({ results: ['archived'] }),
  recent: jest.fn().mockResolvedValue('recent'),
};

const memoryHandlers = {
  store: jest.fn().mockResolvedValue('memory-saved'),
  recall: jest.fn().mockResolvedValue('memory-results'),
  forget: jest.fn().mockResolvedValue('Forgot 1 memory.'),
  edit: jest.fn().mockResolvedValue('memory-updated'),
};

jest.mock('@server/services/ToolService/handlers/search/workspaceSearch/workspaceSearch', () => ({
  __esModule: true,
  default: searchHandlers.workspace,
}));
jest.mock('@server/services/ToolService/handlers/search/docSearch', () => ({
  __esModule: true,
  default: searchHandlers.docs,
}));
jest.mock('@server/services/ToolService/handlers/search/containerSearch', () => ({
  __esModule: true,
  default: searchHandlers.containers,
}));
jest.mock('@server/services/ToolService/handlers/search/codeSearch', () => ({
  __esModule: true,
  default: searchHandlers.code,
}));
jest.mock('@server/services/ToolService/handlers/search/semanticFileSearch', () => ({
  __esModule: true,
  default: searchHandlers.files,
}));
jest.mock('@server/services/ToolService/handlers/search/databaseSearch', () => ({
  __esModule: true,
  default: searchHandlers.database,
}));
jest.mock('@server/services/ToolService/handlers/search/findConversation/findConversation', () => ({
  __esModule: true,
  default: searchHandlers.conversations,
}));
jest.mock('@server/services/ToolService/handlers/search/listArchived', () => ({
  __esModule: true,
  default: searchHandlers.archived,
}));
jest.mock('@server/services/ToolService/handlers/search/listRecent', () => ({
  __esModule: true,
  default: searchHandlers.recent,
}));

jest.mock('@server/services/ToolService/handlers/memory/memoryStore', () => ({
  __esModule: true,
  default: memoryHandlers.store,
}));
jest.mock('@server/services/ToolService/handlers/memory/memoryRecall', () => ({
  __esModule: true,
  default: memoryHandlers.recall,
}));
jest.mock('@server/services/ToolService/handlers/memory/memoryForget', () => ({
  __esModule: true,
  default: memoryHandlers.forget,
}));
jest.mock('@server/services/ToolService/handlers/memory/memoryEdit', () => ({
  __esModule: true,
  default: memoryHandlers.edit,
}));

import search from '@server/services/ToolService/tools/workspace/search/tool';
import memory from '@server/services/ToolService/tools/memory/memory/tool';

describe('canonical search routing', () => {
  const settings = { root_dir: '/repo' };
  const context = { agentId: 'agent-1' } as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['all', searchHandlers.workspace, 'workspace'],
    ['docs', searchHandlers.docs, 'docs'],
    ['containers', searchHandlers.containers, 'containers'],
    ['database', searchHandlers.database, 'database'],
    ['conversations', searchHandlers.conversations, 'conversations'],
  ])('routes kind=%s without adapting parameters', async (kind, handler, expected) => {
    const input = { kind, query: 'needle', limit: 7 };
    await expect(search(input, settings, context)).resolves.toBe(expected);
    expect(handler).toHaveBeenCalledWith(input, settings, context);
  });

  it('adapts code-specific parameters', async () => {
    const input = { kind: 'code', query: 'symbol', code_mode: 'regex', limit: 12 };
    await expect(search(input, settings, context)).resolves.toBe('code');
    expect(searchHandlers.code).toHaveBeenCalledWith(
      { ...input, mode: 'regex', max_results: 12 },
      settings,
      context
    );
  });

  it('adapts the semantic-file result limit', async () => {
    const input = { kind: 'files', query: 'architecture', limit: 9 };
    await expect(search(input, settings, context)).resolves.toBe('files');
    expect(searchHandlers.files).toHaveBeenCalledWith(
      { ...input, maxResults: 9 },
      settings,
      context
    );
  });

  it('routes archived filters before kind dispatch', async () => {
    const result = await search(
      { kind: 'docs', archived_only: true, kinds: ['doc', 'container'], limit: 4 },
      settings,
      context
    );
    expect(JSON.parse(String(result))).toEqual({ results: ['archived'] });
    expect(searchHandlers.archived).toHaveBeenCalledWith({ limit: 4, type: 'doc' });
    expect(searchHandlers.docs).not.toHaveBeenCalled();
  });

  it('routes recent sorting before kind dispatch', async () => {
    const input = { kind: 'docs', sort: 'recent', limit: 3 };
    await expect(search(input, settings, context)).resolves.toBe('recent');
    expect(searchHandlers.recent).toHaveBeenCalledWith(input, settings, context);
    expect(searchHandlers.docs).not.toHaveBeenCalled();
  });
});

describe('canonical memory routing', () => {
  const settings = { namespace: 'test' };
  const context = { agentId: 'agent-1' } as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes op create to the single memory store', async () => {
    const input = { op: 'create', key: 'timezone', content: 'UTC' };
    await expect(memory(input, settings, context)).resolves.toBe('memory-saved');
    expect(memoryHandlers.store).toHaveBeenCalledWith(input, settings, context);
  });

  it('routes op search through the recall handler', async () => {
    const input = { op: 'search', query: 'timezone', limit: 5 };
    await expect(memory(input, settings, context)).resolves.toBe('memory-results');
    expect(memoryHandlers.recall).toHaveBeenCalledWith(input, settings, context);
  });

  it('routes op update to the edit handler', async () => {
    const input = { op: 'update', key: 'timezone', mode: 'overwrite', content: 'PST' };
    await expect(memory(input, settings, context)).resolves.toBe('memory-updated');
    expect(memoryHandlers.edit).toHaveBeenCalledWith(input, settings, context);
  });

  it('routes op delete to the memory-forget handler', async () => {
    const input = { op: 'delete', memory_id: 'memory-1' };
    await expect(memory(input, settings, context)).resolves.toBe('Forgot 1 memory.');
    expect(memoryHandlers.forget).toHaveBeenCalledWith(input, settings, context);
  });

  it('refuses a missing or unknown op without touching the store', async () => {
    for (const input of [{}, { op: 'forget' }]) {
      await expect(memory(input, settings, context)).rejects.toThrow(
        'op is required and must be one of search | create | update | delete.'
      );
    }
    for (const fn of Object.values(memoryHandlers)) expect(fn).not.toHaveBeenCalled();
  });
});
