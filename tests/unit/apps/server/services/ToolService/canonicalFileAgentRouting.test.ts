import path from 'node:path';

const PROJECT_ROOT = path.resolve('fixture-project');
const SOURCE_DIR = path.join(PROJECT_ROOT, 'src');

const fileHandlers = {
  multiple: jest.fn().mockResolvedValue('multiple-files'),
  image: jest.fn().mockResolvedValue('image-file'),
  find: jest.fn().mockResolvedValue('found-files'),
  tree: jest.fn().mockResolvedValue('file-tree'),
};

const agentHandlers = {
  recent: jest.fn().mockResolvedValue('agent-recent'),
  selfRecent: jest.fn().mockResolvedValue('self-recent'),
  selfHistory: jest.fn().mockResolvedValue('self-history'),
  providers: jest.fn().mockResolvedValue('providers'),
  models: jest.fn().mockResolvedValue('models'),
  updateAgent: jest.fn().mockResolvedValue('agent-updated'),
  updateSelf: jest.fn().mockResolvedValue('self-updated'),
};

const fsMocks = {
  readFile: jest.fn(),
  readdir: jest.fn(),
  stat: jest.fn(),
};
const validatePathConstraintMock = jest.fn();
const resolveToolCwdMock = jest.fn().mockReturnValue(PROJECT_ROOT);

jest.mock('@server/services/ToolService/handlers/files/readMultipleFiles', () => ({
  __esModule: true,
  default: fileHandlers.multiple,
}));
jest.mock('@server/services/ToolService/handlers/files/viewImage', () => ({
  __esModule: true,
  default: fileHandlers.image,
}));
jest.mock('@server/services/ToolService/handlers/files/findFiles', () => ({
  __esModule: true,
  default: fileHandlers.find,
}));
jest.mock('@server/services/ToolService/handlers/files/repoTree', () => ({
  __esModule: true,
  default: fileHandlers.tree,
}));
jest.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => fsMocks.readFile(...args),
  readdir: (...args: unknown[]) => fsMocks.readdir(...args),
  stat: (...args: unknown[]) => fsMocks.stat(...args),
}));
jest.mock('@server/services/ToolService/handlers/_shared', () => ({
  validatePathConstraint: (...args: unknown[]) => validatePathConstraintMock(...args),
}));
jest.mock('@server/services/ToolService/lib/resolveToolCwd', () => ({
  resolveToolCwd: (...args: unknown[]) => resolveToolCwdMock(...args),
}));

jest.mock('@server/services/ToolService/handlers/agents/agentRecentActivity', () => ({
  __esModule: true,
  default: agentHandlers.recent,
}));
jest.mock('@server/services/ToolService/handlers/agents/myActivity', () => ({
  __esModule: true,
  default: agentHandlers.selfRecent,
}));
jest.mock('@server/services/ToolService/handlers/agents/runHistory', () => ({
  __esModule: true,
  default: agentHandlers.selfHistory,
}));
jest.mock('@server/services/ToolService/handlers/agents/getProviders', () => ({
  __esModule: true,
  default: agentHandlers.providers,
}));
jest.mock('@server/services/ToolService/handlers/agents/getProviderModels', () => ({
  __esModule: true,
  default: agentHandlers.models,
}));
jest.mock('@server/services/ToolService/handlers/agents/updateAgent', () => ({
  __esModule: true,
  default: agentHandlers.updateAgent,
}));
jest.mock('@server/services/ToolService/handlers/agents/updateIdentity', () => ({
  __esModule: true,
  default: agentHandlers.updateSelf,
}));

import fileRead from '@server/services/ToolService/tools/files/fileRead';
import fileList from '@server/services/ToolService/tools/files/fileList';
import agentActivity from '@server/services/ToolService/handlers/agents/agentActivity';
import listModels from '@server/services/ToolService/handlers/agents/listModels';
import updateAgent from '@server/services/ToolService/handlers/agents/agentUpdate';

describe('canonical file routing', () => {
  const settings = { root_dir: PROJECT_ROOT };
  const context = { agentId: 'agent-1', cwd: PROJECT_ROOT } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    resolveToolCwdMock.mockReturnValue(PROJECT_ROOT);
  });

  it.each([
    ['multiple', fileHandlers.multiple, 'multiple-files'],
    ['image', fileHandlers.image, 'image-file'],
  ])('routes file_read mode=%s', async (mode, handler, expected) => {
    const input = { mode, paths: ['a.ts'] };
    await expect(fileRead(input, settings, context)).resolves.toBe(expected);
    expect(handler).toHaveBeenCalledWith(input, settings, context);
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });

  it('reads text directly for text mode', async () => {
    fsMocks.readFile.mockResolvedValue('alpha\nbeta');
    const input = { mode: 'text', path: 'src/index.ts' };

    await expect(fileRead(input, settings, context)).resolves.toBe('alpha\nbeta');
    expect(resolveToolCwdMock).toHaveBeenCalledWith(undefined, context);
    expect(validatePathConstraintMock).toHaveBeenCalledWith(
      path.join(SOURCE_DIR, 'index.ts'),
      settings
    );
    expect(fsMocks.readFile).toHaveBeenCalledWith(path.join(SOURCE_DIR, 'index.ts'), 'utf-8');
    expect(fileHandlers.multiple).not.toHaveBeenCalled();
    expect(fileHandlers.image).not.toHaveBeenCalled();
  });

  it.each([
    ['find', fileHandlers.find, 'found-files'],
    ['tree', fileHandlers.tree, 'file-tree'],
  ])('routes file_list mode=%s', async (mode, handler, expected) => {
    const input = { mode, path: SOURCE_DIR };
    await expect(fileList(input, settings, context)).resolves.toBe(expected);
    expect(handler).toHaveBeenCalledWith(
      mode === 'find' ? { ...input, nameContains: undefined, maxResults: undefined } : input,
      settings,
      context
    );
    expect(fsMocks.readdir).not.toHaveBeenCalled();
  });

  it('lists directory entries directly for list mode', async () => {
    fsMocks.readdir.mockResolvedValue([
      { name: 'src', isDirectory: () => true },
      { name: 'package.json', isDirectory: () => false },
    ]);
    const input = { mode: 'list', path: PROJECT_ROOT, recursive: false };

    await expect(fileList(input, settings, context)).resolves.toBe(
      '[dir] src\n[file] package.json'
    );
    expect(validatePathConstraintMock).toHaveBeenCalledWith(PROJECT_ROOT, settings);
    expect(fsMocks.readdir).toHaveBeenCalledWith(PROJECT_ROOT, { withFileTypes: true });
    expect(fileHandlers.find).not.toHaveBeenCalled();
    expect(fileHandlers.tree).not.toHaveBeenCalled();
  });
});

describe('canonical agent routing', () => {
  const settings = { visibility: 'all' };
  const context = { agentId: 'agent-1' } as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['agent', agentHandlers.recent, 'agent-recent'],
    ['self_recent', agentHandlers.selfRecent, 'self-recent'],
    ['self_history', agentHandlers.selfHistory, 'self-history'],
  ])('routes agent_activity view=%s', async (view, handler, expected) => {
    const input = { view, limit: 10 };
    await expect(agentActivity(input, settings, context)).resolves.toBe(expected);
    expect(handler).toHaveBeenCalledWith(input, settings, context);
  });

  it.each([
    ['providers', agentHandlers.providers, 'providers'],
    ['models', agentHandlers.models, 'models'],
  ])('routes list_models operation=%s', async (operation, handler, expected) => {
    const input = { operation, provider_id: 'provider-1' };
    await expect(listModels(input, settings, context)).resolves.toBe(expected);
    expect(handler).toHaveBeenCalledWith(input, settings, context);
  });

  it.each([
    ['self', agentHandlers.updateSelf, 'self-updated'],
    ['agent', agentHandlers.updateAgent, 'agent-updated'],
  ])('routes update_agent scope=%s', async (scope, handler, expected) => {
    const input = { scope, agent_id: 'agent-2', name: 'Updated' };
    await expect(updateAgent(input, settings, context)).resolves.toBe(expected);
    expect(handler).toHaveBeenCalledWith(input, settings, context);
  });
});
