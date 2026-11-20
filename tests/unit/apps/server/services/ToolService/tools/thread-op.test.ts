/**
 * thread(op). The dispatcher hands each handler exactly the input its alias
 * validates (no `op`, no leftover `id` once param_aliases copied it to
 * `thread_id`), and delete returns the JSON the executor produces from its
 * plain-object result.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const calls: Record<string, unknown[]> = {};
function stub(name: string, result: unknown = `${name}-ok`) {
  return {
    __esModule: true,
    default: jest.fn(async (input: unknown) => {
      (calls[name] ??= []).push(input);
      return result;
    }),
  };
}

jest.mock('@server/services/ToolService/handlers/threads/threadSend', () => stub('send'));
jest.mock('@server/services/ToolService/handlers/threads/threadReadOp', () => stub('read'));
jest.mock('@server/services/ToolService/handlers/threads/threadCreate', () => stub('create'));
jest.mock('@server/services/ToolService/handlers/threads/threadUpdate', () => stub('update'));
jest.mock('@server/services/ToolService/handlers/threads/threadLeave', () => stub('leave'));
jest.mock('@server/services/ToolService/handlers/threads/threadMembers', () => ({
  threadAddAgents: stub('add_agents').default,
  threadRemoveAgents: stub('remove_agents').default,
}));
jest.mock('@server/services/ToolService/handlers/threads/threadDelete', () =>
  stub('delete', { success: true, thread_id: 't-1', title: 'T', message: 'deleted' })
);

import threadTool from '@server/services/ToolService/tools/threads/thread/tool';
import definition from '@server/services/ToolService/tools/threads/thread/definition';
import { normalizeToolParams } from '@server/services/ToolService/lib/normalizeToolParams';

/** The executor's arg pipeline for a direct `thread` call: param_aliases, then handler. */
function run(input: Record<string, unknown>) {
  return threadTool(
    normalizeToolParams(input, definition.param_aliases),
    {},
    {
      agentId: 'agent-1',
      threadId: 'thread-here',
    }
  );
}

describe('thread(op) dispatcher', () => {
  beforeEach(() => {
    for (const key of Object.keys(calls)) delete calls[key];
  });

  it('passes unlisted fields through to the handler unchanged', async () => {
    const update = { thread: { dispatch_mode: 'mentioned' } };
    await run({ op: 'update', id: 't-1', ...update });
    expect(calls.update).toEqual([{ thread_id: 't-1', ...update }]);

    const create = { title: 'T', agent_ids: ['a-1'] };
    await run({ op: 'create', ...create, system_prompt: 'p' });
    expect(calls.create).toEqual([{ ...create, system_prompt: 'p' }]);
  });

  it.each(['read', 'create', 'update'])(
    'routes op %s to its handler with op stripped',
    async (op) => {
      await expect(run({ op, title: 'x' })).resolves.toBe(`${op}-ok`);
      expect(calls[op]).toEqual([{ title: 'x' }]);
    }
  );

  it('maps id to thread_id and drops id, so update sees only its own top-level keys', async () => {
    await run({ op: 'update', id: 't-9', thread: { title: 'New' } });
    expect(calls.update).toEqual([{ thread_id: 't-9', thread: { title: 'New' } }]);
  });

  it('an explicit thread_id wins over id (handler key always wins)', async () => {
    await run({ op: 'read', id: 't-a', thread_id: 't-b' });
    expect(calls.read).toEqual([{ thread_id: 't-b' }]);
  });

  it('delete returns the JSON output of the plain-object result', async () => {
    const out = await run({ op: 'delete', id: 't-1', confirm: true });
    expect(out).toBe(
      JSON.stringify({ success: true, thread_id: 't-1', title: 'T', message: 'deleted' })
    );
    expect(calls.delete).toEqual([{ thread_id: 't-1', confirm: true }]);
  });

  it('routes add_agents and remove_agents to the membership handlers with agent_ids', async () => {
    await expect(run({ op: 'add_agents', id: 't-1', agent_ids: ['a-1'] })).resolves.toBe(
      'add_agents-ok'
    );
    await expect(run({ op: 'remove_agents', agent_ids: ['a-2'] })).resolves.toBe(
      'remove_agents-ok'
    );
    expect(calls.add_agents).toEqual([{ thread_id: 't-1', agent_ids: ['a-1'] }]);
    expect(calls.remove_agents).toEqual([{ agent_ids: ['a-2'] }]);
  });

  it('send: hands the handler content and thread_id, without op or id', async () => {
    await run({ op: 'send', id: 't-1', content: 'hello' });
    expect(calls.send).toEqual([{ thread_id: 't-1', content: 'hello' }]);
  });

  it('routes op leave and its aliases leave_thread / remove_me to the leave handler', async () => {
    for (const op of ['leave', 'leave_thread', 'remove_me']) {
      await expect(run({ op })).resolves.toBe('leave-ok');
    }
    await run({ op: 'leave', id: 't-2' });
    expect(calls.leave).toEqual([{}, {}, {}, { thread_id: 't-2' }]);
  });

  it('rejects a missing or unknown op without calling any handler', async () => {
    await expect(run({})).rejects.toThrow(/op is required/);
    // The op is add_agents; the singular name is not an alias.
    await expect(run({ op: 'add_agent', agent_id: 'a-1' })).rejects.toThrow(
      /send \| read \| create \| update \| add_agents \| remove_agents/
    );
    await expect(run({ op: 'post' })).rejects.toThrow(/send \| read \| create \| update/);
    expect(Object.keys(calls)).toEqual([]);
  });
});

describe('thread(op) definition', () => {
  const schema = definition.parameters_schema as {
    required: string[];
    properties: Record<string, { enum?: unknown[] }>;
  };

  it('declares the eight thread ops plus the three dm ops, op required', () => {
    expect(schema.required).toEqual(['op']);
    expect(schema.properties.op.enum).toEqual([
      'send',
      'read',
      'create',
      'update',
      'add_agents',
      'remove_agents',
      'delete',
      'leave',
      'dm_send',
      'dm_list',
      'dm_read',
    ]);
  });

  it('is core via CORE_TOOL_ORDER (tier stays standard), and only delete is destructive (per-op, no whole-tool flag)', () => {
    expect(definition.tier).toBe('standard');
    expect(definition.destructive).toBeUndefined();
    expect(definition.destructiveOps).toEqual(['delete']);
  });

  it('carries every field (create takes agent_ids; the user roster is automatic)', () => {
    for (const field of [
      'id',
      'mode',
      'message_id',
      'limit',
      'before',
      'after',
      'title',
      'project_id',
      'dispatch_mode',
      'agent_ids',
      'initial_message',
      'system_prompt',
      'content',
      'thread',
      'confirm',
    ]) {
      // Listed, or unlisted (accepted, returned by get_tool_schema): either way
      // the field keeps its schema and its handler behavior.
      const listed = field in (schema.properties as Record<string, unknown>);
      const unlisted = field in (definition.unlisted_params ?? {});
      expect({ field, listed, unlisted }).toEqual({ field, listed: !unlisted, unlisted });
      expect(listed || unlisted).toBe(true);
    }
  });

  it('lists the everyday fields and leaves only the rarely used admin fields unlisted', () => {
    expect(Object.keys(definition.unlisted_params ?? {}).sort()).toEqual(
      ['all', 'system_prompt', 'thread', 'to'].sort()
    );
    // send/read/create stay fully advertised.
    for (const field of ['content', 'id', 'title', 'agent_ids', 'dispatch_mode']) {
      expect(schema.properties).toHaveProperty(field);
    }
    // Removing agents is op remove_agents with agent_ids: no separate field.
    expect(schema.properties).not.toHaveProperty('remove_agent_ids');
    // The description points at where the unlisted fields are.
    expect(definition.description).toContain('unlisted_parameters');
  });
});
