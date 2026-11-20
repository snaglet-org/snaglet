import type { ToolHandler } from '@server/services/ToolService/types';
import threadSend from '@server/services/ToolService/handlers/threads/threadSend';
import {
  threadDmSend,
  threadDmList,
  threadDmRead,
} from '@server/services/ToolService/handlers/threads/threadDm';
import threadRead from '@server/services/ToolService/handlers/threads/threadReadOp';
import threadCreate from '@server/services/ToolService/handlers/threads/threadCreate';
import threadUpdate from '@server/services/ToolService/handlers/threads/threadUpdate';
import threadDelete from '@server/services/ToolService/handlers/threads/threadDelete';
import threadLeave from '@server/services/ToolService/handlers/threads/threadLeave';
import {
  threadAddAgents,
  threadRemoveAgents,
} from '@server/services/ToolService/handlers/threads/threadMembers';
import type { ThreadDeleteInputType } from '@server/services/ToolService/handlers/threads/threadDeleteInput';

// threadDelete returns a plain object; stringify it here so the output is the
// same JSON text the thread_delete alias has always returned.
const remove: ToolHandler = async (input) =>
  JSON.stringify(await threadDelete(input as unknown as ThreadDeleteInputType));

const OPS: Record<string, ToolHandler> = {
  send: threadSend,
  read: threadRead,
  create: threadCreate,
  update: threadUpdate,
  add_agents: threadAddAgents,
  remove_agents: threadRemoveAgents,
  delete: remove,
  leave: threadLeave,
  dm_send: threadDmSend,
  dm_list: threadDmList,
  dm_read: threadDmRead,
};

/** Other names for an op, still accepted. */
const OP_ALIASES: Record<string, string> = { leave_thread: 'leave', remove_me: 'leave' };

/**
 * thread(op): one noun tool over the thread handlers.
 *
 * `op` is stripped, and so is the agent-facing `id` once param_aliases has
 * copied it to `thread_id`, so every handler receives exactly the input
 * shape it validates (the update handler rejects unknown top-level keys).
 */
const tool: ToolHandler = async (input, settings, context) => {
  const op = typeof input.op === 'string' ? (OP_ALIASES[input.op] ?? input.op) : undefined;
  const handler = op ? OPS[op] : undefined;
  if (!handler) {
    throw new Error(`op is required and must be one of ${Object.keys(OPS).join(' | ')}.`);
  }
  const { op: _op, ...rest } = input;
  if (rest.thread_id !== undefined) delete rest.id;
  return handler(rest, settings, context);
};

export default tool;
