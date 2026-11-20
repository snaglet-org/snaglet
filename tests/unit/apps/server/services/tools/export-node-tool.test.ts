/**
 * export_node — the internal agent tool.
 *
 * The security property under test: an agent can export its own memories and
 * has no way to name another agent's. That is enforced twice — by the absence
 * of an `agent_id` parameter in the schema, and by the handler binding to
 * `context.agentId`. Both are checked here, because a future edit that adds
 * the parameter back would otherwise pass silently.
 */

import { jest } from '@jest/globals';

const runExport = jest.fn();
const currentActor = jest.fn();

jest.mock('@server/services/ExportService', () => ({
  runExport: (...a: unknown[]) => runExport(...a),
}));
jest.mock('@server/realtime/actorContext', () => ({
  getCurrentActor: () => currentActor(),
}));

import handler from '@server/services/ToolService/tools/workspace/export-node/tool';
import definition from '@server/services/ToolService/tools/workspace/export-node/definition';

const AGENT_CTX = { agentId: 'agent-1', threadId: 'thread-1' };
const AGENT_ACTOR = { actorId: 'agent-1', actorKind: 'agent', actorName: 'Clio' };
const EXTERNAL_ACTOR = { actorId: 'member-9', actorKind: 'external', actorName: 'Partner' };

const ok = {
  result: {
    kind: 'doc',
    id: 'doc-1',
    fileName: 'Notes.md',
    bytes: 10,
    path: '/tmp/out/Notes.md',
    overwritten: false,
    downloaded: false,
  },
};

const call = (input: Record<string, unknown>, context: unknown = AGENT_CTX) =>
  handler(input, {} as never, context as never);

beforeEach(() => {
  jest.clearAllMocks();
  currentActor.mockReturnValue(AGENT_ACTOR);
  runExport.mockResolvedValue(ok);
});

describe('schema shape is part of the enforcement', () => {
  it('has no agent_id parameter at all', () => {
    const props = definition.parameters_schema.properties as Record<string, unknown>;
    expect(props.agent_id).toBeUndefined();
    expect(Object.keys(props)).toEqual(['kind', 'id', 'dest_dir', 'file_name', 'message_limit']);
  });

  it('forbids extra properties, so agent_id cannot be smuggled in', () => {
    expect(definition.parameters_schema.additionalProperties).toBe(false);
  });

  it('offers own_memories rather than a general memories kind', () => {
    const kind = (definition.parameters_schema.properties as Record<string, { enum?: string[] }>)
      .kind;
    expect(kind.enum).toEqual(['doc', 'thread', 'image', 'own_memories']);
  });
});

describe('own_memories binds to the calling agent', () => {
  it('uses context.agentId for both the target and the authorization', async () => {
    await call({ kind: 'own_memories', dest_dir: '/tmp/out' });

    expect(runExport).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'agent_memories',
        id: 'agent-1',
        allowedAgentId: 'agent-1',
      })
    );
  });

  it('refuses a stray id naming a different agent instead of ignoring it', async () => {
    // Silently dropping the parameter would let a caller believe it had
    // exported agent-2 while receiving agent-1's memories under that name.
    await expect(
      call({ kind: 'own_memories', id: 'agent-2', dest_dir: '/tmp/out' })
    ).rejects.toThrow(/does not take an agent id/i);
    expect(runExport).not.toHaveBeenCalled();
  });

  it('tolerates an id that redundantly names the caller', async () => {
    await call({ kind: 'own_memories', id: 'agent-1', dest_dir: '/tmp/out' });
    expect(runExport).toHaveBeenCalledWith(expect.objectContaining({ allowedAgentId: 'agent-1' }));
  });

  it('refuses an external MCP caller outright', async () => {
    currentActor.mockReturnValue(EXTERNAL_ACTOR);
    await expect(
      call({ kind: 'own_memories', dest_dir: '/tmp/out' }, { agentId: 'agent-1' })
    ).rejects.toThrow(/by an agent, and only its own/i);
    expect(runExport).not.toHaveBeenCalled();
  });

  it('refuses when there is no calling agent', async () => {
    await expect(call({ kind: 'own_memories', dest_dir: '/tmp/out' }, {})).rejects.toThrow(
      /by an agent, and only its own/i
    );
    expect(runExport).not.toHaveBeenCalled();
  });
});

describe('node kinds', () => {
  it('exports a doc by id without any agent constraint', async () => {
    await call({ kind: 'doc', id: 'doc-1', dest_dir: '/tmp/out' });
    expect(runExport).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'doc', id: 'doc-1', allowedAgentId: undefined })
    );
  });

  it('requires an id for node kinds', async () => {
    await expect(call({ kind: 'thread', dest_dir: '/tmp/out' })).rejects.toThrow(/id is required/i);
  });

  it('passes a thread message limit through', async () => {
    await call({ kind: 'thread', id: 't-1', dest_dir: '/tmp/out', message_limit: 500 });
    expect(runExport).toHaveBeenCalledWith(
      expect.objectContaining({ options: { messageLimit: 500 } })
    );
  });

  it('rejects a nonsense message limit', async () => {
    await expect(
      call({ kind: 'thread', id: 't-1', dest_dir: '/tmp/out', message_limit: -3 })
    ).rejects.toThrow(/positive integer/i);
  });
});

describe('agent exports never overwrite', () => {
  it('does not send an overwrite flag even if the input carries one', async () => {
    await call({ kind: 'doc', id: 'doc-1', dest_dir: '/tmp/out', overwrite: true });
    const [args] = runExport.mock.calls[0] as [{ options?: Record<string, unknown> }];
    expect(args.options?.overwrite).toBeUndefined();
  });
});

describe('validation', () => {
  it('rejects an unknown kind', async () => {
    await expect(call({ kind: 'container', id: 'c-1', dest_dir: '/tmp' })).rejects.toThrow(
      /kind must be one of/i
    );
  });

  it('requires dest_dir — there is no implicit destination', async () => {
    await expect(call({ kind: 'doc', id: 'doc-1' })).rejects.toThrow(/dest_dir is required/i);
  });
});

describe('result reporting', () => {
  it('reports the path actually written, not the requested name', async () => {
    runExport.mockResolvedValue({
      result: { ...ok.result, fileName: 'Notes (2).md', path: '/tmp/out/Notes (2).md' },
    });

    const raw = await call({
      kind: 'doc',
      id: 'doc-1',
      dest_dir: '/tmp/out',
      file_name: 'Notes.md',
    });

    expect(JSON.parse(raw as string)).toMatchObject({
      success: true,
      path: '/tmp/out/Notes (2).md',
      file_name: 'Notes (2).md',
    });
  });

  it('surfaces a guard rejection rather than claiming success', async () => {
    runExport.mockRejectedValue(new Error('Destination folder does not exist: /nope'));
    await expect(call({ kind: 'doc', id: 'doc-1', dest_dir: '/nope' })).rejects.toThrow(
      /does not exist/i
    );
  });
});
