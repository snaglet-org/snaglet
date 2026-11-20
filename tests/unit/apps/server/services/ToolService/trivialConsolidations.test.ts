const mockHandlers = {
  filesystemResolvePath: jest.fn().mockResolvedValue('filesystem'),
  workspaceResolvePath: jest.fn().mockResolvedValue('workspace'),
  localContext: jest.fn().mockResolvedValue('local'),
  workspaceOrient: jest.fn().mockResolvedValue('workspace-orient'),
  workspaceTree: jest.fn().mockResolvedValue('tree'),
  workspaceProjectTree: jest.fn().mockResolvedValue('project-tree'),
  threadRead: jest.fn().mockResolvedValue('thread'),
  messageContext: jest.fn().mockResolvedValue('window'),
  getAgent: jest.fn().mockResolvedValue('agent'),
  selfInspect: jest.fn().mockResolvedValue('runtime'),
  getCurrentDatetime: jest.fn().mockResolvedValue('clock'),
  dateTime: jest.fn().mockResolvedValue('legacy-clock'),
};

jest.mock('@server/services/ToolService/handlers/trivial/filesystemResolvePath', () => ({
  __esModule: true,
  default: mockHandlers.filesystemResolvePath,
}));
jest.mock('@server/services/ToolService/handlers/trivial/workspaceResolvePath', () => ({
  __esModule: true,
  default: mockHandlers.workspaceResolvePath,
}));
jest.mock('@server/services/ToolService/handlers/trivial/localContext', () => ({
  __esModule: true,
  default: mockHandlers.localContext,
}));
jest.mock('@server/services/ToolService/handlers/trivial/workspaceOrient', () => ({
  __esModule: true,
  default: mockHandlers.workspaceOrient,
}));
jest.mock('@server/services/ToolService/handlers/trivial/workspaceTree', () => ({
  __esModule: true,
  default: mockHandlers.workspaceTree,
}));
jest.mock('@server/services/ToolService/handlers/trivial/workspaceProjectTree', () => ({
  __esModule: true,
  default: mockHandlers.workspaceProjectTree,
}));
jest.mock('@server/services/ToolService/handlers/trivial/threadRead', () => ({
  __esModule: true,
  default: mockHandlers.threadRead,
}));
jest.mock('@server/services/ToolService/handlers/trivial/messageContext', () => ({
  __esModule: true,
  default: mockHandlers.messageContext,
}));
jest.mock('@server/services/ToolService/handlers/trivial/getAgent', () => ({
  __esModule: true,
  default: mockHandlers.getAgent,
}));
jest.mock('@server/services/ToolService/handlers/trivial/selfInspect', () => ({
  __esModule: true,
  default: mockHandlers.selfInspect,
}));
jest.mock('@server/services/ToolService/handlers/trivial/getCurrentDatetime', () => ({
  __esModule: true,
  default: mockHandlers.getCurrentDatetime,
}));
jest.mock('@server/services/ToolService/handlers/trivial/dateTime', () => ({
  __esModule: true,
  default: mockHandlers.dateTime,
}));

import resolvePath from '@server/services/ToolService/tools/shell/resolve-path/tool';
import orient from '@server/services/ToolService/tools/workspace/orient/tool';
import workspaceTree from '@server/services/ToolService/handlers/workspace/workspaceTreeOp';
import threadRead from '@server/services/ToolService/handlers/threads/threadReadOp';
import getAgent from '@server/services/ToolService/handlers/agents/agentGet';
import getCurrentDatetime from '@server/services/ToolService/tools/system/get-current-datetime/tool';

describe('trivial consolidation routers', () => {
  beforeEach(() => {
    for (const handler of Object.values(mockHandlers)) handler.mockClear();
  });

  it.each([
    ['filesystem', mockHandlers.filesystemResolvePath, 'filesystem'],
    ['workspace', mockHandlers.workspaceResolvePath, 'workspace'],
  ])('routes resolve_path domain=%s', async (domain, expected, output) => {
    await expect(resolvePath({ domain }, {}, undefined)).resolves.toBe(output);
    expect(expected).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['local', mockHandlers.localContext, 'local'],
    ['workspace', mockHandlers.workspaceOrient, 'workspace-orient'],
  ])('routes orient mode=%s', async (mode, expected, output) => {
    await expect(orient({ mode }, {}, undefined)).resolves.toBe(output);
    expect(expected).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['current_project', mockHandlers.workspaceProjectTree, 'project-tree'],
    ['workspace', mockHandlers.workspaceTree, 'tree'],
  ])('routes workspace_tree scope=%s', async (scope, expected, output) => {
    await expect(workspaceTree({ scope }, {}, undefined)).resolves.toBe(output);
    expect(expected).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['message_context', mockHandlers.messageContext, 'window'],
    ['thread', mockHandlers.threadRead, 'thread'],
  ])('routes thread_read mode=%s', async (mode, expected, output) => {
    await expect(threadRead({ mode }, {}, undefined)).resolves.toBe(output);
    expect(expected).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['runtime_self', mockHandlers.selfInspect, 'runtime'],
    ['record', mockHandlers.getAgent, 'agent'],
  ])('routes get_agent view=%s', async (view, expected, output) => {
    await expect(getAgent({ view }, {}, undefined)).resolves.toBe(output);
    expect(expected).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['date_time', mockHandlers.dateTime, 'legacy-clock'],
    ['standard', mockHandlers.getCurrentDatetime, 'clock'],
  ])('routes get_current_datetime compat=%s', async (compat, expected, output) => {
    await expect(getCurrentDatetime({ compat }, {}, undefined)).resolves.toBe(output);
    expect(expected).toHaveBeenCalledTimes(1);
  });
});
