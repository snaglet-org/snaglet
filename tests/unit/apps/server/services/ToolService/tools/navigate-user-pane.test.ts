/**
 * navigate_user_pane — handler unit tests.
 *
 * Verifies the flat `{ kind, id }` target maps to the correct camelCase wire
 * field per kind, that the target node is verified to exist (and match the kind)
 * before broadcasting, that bad input is rejected before emitting, and that a
 * missing client degrades gracefully. The UI transport and node lookup are mocked.
 */

const mockEmit = jest.fn();
const mockResolveUser = jest.fn();
jest.mock('@server/realtime/surfaces/ui', () => ({
  emitNavigatePane: (...args: unknown[]) => mockEmit(...args),
  resolveAnyConnectedUserId: (...args: unknown[]) => mockResolveUser(...args),
}));

const mockFindById = jest.fn();
jest.mock('@snaglet/db/tables/nodes', () => ({
  Nodes: { findById: (...args: unknown[]) => mockFindById(...args) },
}));

import navigateUserPane from '@server/services/ToolService/handlers/workspace/navigatePane';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = { agentId: 'agent-1' } as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveUser.mockReturnValue('user-1');
  mockEmit.mockReturnValue({ delivered: true, clientCount: 1 });
  // By default the node exists and its type is the id's prefix, so a target like
  // { kind: 'doc', id: 'doc-1' } resolves to a matching doc node.
  mockFindById.mockImplementation((id: string) =>
    Promise.resolve({ id, type: String(id).split('-')[0] })
  );
});

async function run(input: unknown): Promise<{ success: boolean; reason?: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return JSON.parse((await navigateUserPane(input as any, {}, ctx)) as string);
}

function emittedCommand(): { paneKey: string | null; target: Record<string, string> } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mockEmit.mock.calls[0][0] as any).command;
}

describe('navigate_user_pane handler', () => {
  test('maps { kind: "doc", id } to the docId wire field', async () => {
    const res = await run({ target: { kind: 'doc', id: 'doc-1' } });
    expect(res.success).toBe(true);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(emittedCommand().target).toEqual({ kind: 'doc', docId: 'doc-1' });
    expect(emittedCommand().paneKey).toBeNull();
  });

  test('maps container/tool/image to their wire fields', async () => {
    const cases: Array<[string, string]> = [
      ['container', 'containerId'],
      ['tool', 'toolId'],
      ['image', 'imageId'],
    ];
    for (const [kind, wireKey] of cases) {
      mockEmit.mockClear();
      await run({ target: { kind, id: `${kind}-9` } });
      expect(emittedCommand().target).toEqual({ kind, [wireKey]: `${kind}-9` });
    }
  });

  test('passes pane_key through to the command', async () => {
    await run({ pane_key: 'root.1', target: { kind: 'container', id: 'container-9' } });
    expect(emittedCommand().paneKey).toBe('root.1');
  });

  test('thread target carries optional agent_id as agentId', async () => {
    await run({ target: { kind: 'thread', id: 'thread-2', agent_id: 'agent-x' } });
    expect(emittedCommand().target).toEqual({
      kind: 'thread',
      threadId: 'thread-2',
      agentId: 'agent-x',
    });
  });

  test('providers needs no id and skips the node lookup', async () => {
    const res = await run({ target: { kind: 'providers' } });
    expect(res.success).toBe(true);
    expect(mockFindById).not.toHaveBeenCalled();
    expect(emittedCommand().target).toEqual({ kind: 'providers' });
  });

  test('rejects a target whose id does not exist, and does not broadcast', async () => {
    mockFindById.mockResolvedValue(null);
    const res = await run({ target: { kind: 'container', id: 'container-doesnotexist' } });
    expect(res.success).toBe(false);
    expect(res.reason).toBe('target_not_found');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('rejects a target whose kind does not match the node, and does not broadcast', async () => {
    mockFindById.mockResolvedValue({ id: 'x', type: 'thread' });
    const res = await run({ target: { kind: 'doc', id: 'x' } });
    expect(res.success).toBe(false);
    expect(res.reason).toBe('target_not_found');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('rejects a non-providers kind without an id and does not emit', async () => {
    const res = await run({ target: { kind: 'doc' } });
    expect(res.success).toBe(false);
    expect(res.reason).toBe('missing_id');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('rejects an unknown kind', async () => {
    const res = await run({ target: { kind: 'nope', id: 'x' } });
    expect(res.success).toBe(false);
    expect(res.reason).toBe('invalid_kind');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('rejects a missing target', async () => {
    const res = await run({});
    expect(res.success).toBe(false);
    expect(res.reason).toBe('missing_target');
  });

  test('reports no_active_client when nobody is connected', async () => {
    mockResolveUser.mockReturnValue(null);
    const res = await run({ target: { kind: 'doc', id: 'doc-1' } });
    expect(res.success).toBe(false);
    expect(res.reason).toBe('no_active_client');
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
