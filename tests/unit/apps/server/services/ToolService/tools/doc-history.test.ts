const mockSnapshot = jest.fn();
const mockList = jest.fn();
const mockRestore = jest.fn();
const mockDelete = jest.fn();

jest.mock('@server/services/ToolService/handlers/docs/history/snapshot', () => ({
  __esModule: true,
  default: mockSnapshot,
}));
jest.mock('@server/services/ToolService/handlers/docs/history/list', () => ({
  __esModule: true,
  default: mockList,
}));
jest.mock('@server/services/ToolService/handlers/docs/history/restore', () => ({
  __esModule: true,
  default: mockRestore,
}));
jest.mock('@server/services/ToolService/handlers/docs/history/delete', () => ({
  __esModule: true,
  default: mockDelete,
}));

jest.mock('@server/services/ToolService/handlers/docs/getDoc', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('@server/services/ToolService/handlers/docs/createDoc', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('@server/services/ToolService/handlers/docs/editDoc', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('@server/services/ToolService/handlers/docs/deleteDoc', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('@server/services/ToolService/handlers/docs/duplicateDoc', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('@server/services/ToolService/handlers/docs/diffDoc', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('@server/services/ToolService/handlers/docs/convertDocToContainer', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('@server/services/WorkspaceService/pathResolver', () => ({
  resolveDocByPath: jest.fn(),
}));

import docHistory from '@server/services/ToolService/tools/docs/doc/tool';

describe('doc snapshot operations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSnapshot.mockResolvedValue({ output: 'snapshotted' });
    mockList.mockResolvedValue({ output: 'listed' });
    mockRestore.mockResolvedValue({ output: 'restored' });
    mockDelete.mockResolvedValue({ output: 'deleted' });
  });

  it.each([
    ['snapshot', mockSnapshot, { doc_id: 'doc-1', label: 'before edit' }],
    ['list-snapshots', mockList, { doc_id: 'doc-1', limit: 5 }],
    ['restore', mockRestore, { snapshot_id: 'snap-1' }],
    ['delete-snapshot', mockDelete, { snapshot_id: 'snap-1' }],
  ])('routes operation %s and removes the discriminator', async (operation, expected, params) => {
    await docHistory({ op: operation, ...params }, { enabled: true }, { agentId: 'agent-1' });

    expect(expected).toHaveBeenCalledWith(params, { enabled: true }, { agentId: 'agent-1' });
  });

  it('rejects missing and unsupported operations', async () => {
    await expect(docHistory({}, {}, undefined)).rejects.toThrow(/op is required/);
    await expect(docHistory({ op: 'purge' }, {}, undefined)).rejects.toThrow(/op is required/);
  });
});
