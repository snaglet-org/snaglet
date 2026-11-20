import type { ToolHandler } from '@server/services/ToolService/types';
import { runHookOnDemand } from '@server/services/customHooks/runHookOnDemand';

interface RunHookToolInput {
  hook_id_or_name?: unknown;
  event_name?: unknown;
  message_id?: unknown;
  thread_id?: unknown;
  table_id?: unknown;
  entry_id?: unknown;
  agent_id?: unknown;
  run_id?: unknown;
  payload?: unknown;
  force?: unknown;
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const ID_FIELDS = ['message_id', 'thread_id', 'agent_id', 'run_id', 'table_id'] as const;

const execute: ToolHandler = async (rawInput, _settings, context) => {
  const input = rawInput as RunHookToolInput;
  const hookIdOrName = trimmed(input.hook_id_or_name);
  if (!hookIdOrName) throw new Error('hook_id_or_name is required');

  const suppliedIds = ID_FIELDS.flatMap((field) => {
    const value = trimmed(input[field]);
    return value ? [{ field, value }] : [];
  });
  if (suppliedIds.length > 1) {
    throw new Error(
      `Pass exactly one mock entity ID, not: ${suppliedIds.map(({ field }) => field).join(', ')}`
    );
  }
  if (suppliedIds.length > 0 && input.payload != null) {
    throw new Error('Pass a mock entity ID or payload, not both');
  }
  const entryId = trimmed(input.entry_id);
  if (entryId && suppliedIds[0]?.field !== 'table_id') {
    throw new Error('entry_id goes with table_id');
  }
  if (suppliedIds[0]?.field === 'table_id' && !entryId) {
    throw new Error('table_id requires entry_id');
  }
  if (
    input.payload != null &&
    (typeof input.payload !== 'object' || Array.isArray(input.payload))
  ) {
    throw new Error('payload must be an object');
  }

  const selected = suppliedIds[0];
  const eventName = trimmed(input.event_name) ?? inferEventName(selected?.field);
  validateIdForEvent(selected?.field, eventName);

  const result = await runHookOnDemand(
    hookIdOrName,
    {
      ...(selected?.field === 'table_id'
        ? { tableId: selected.value, entryId }
        : { nodeIds: selected?.value }),
      eventName,
      event: input.payload as Record<string, unknown> | undefined,
      force: input.force === true,
    },
    { contextAgentId: context?.agentId }
  );
  return JSON.stringify(result);
};

function inferEventName(field: (typeof ID_FIELDS)[number] | undefined): string | undefined {
  switch (field) {
    case 'message_id':
      return 'message:create';
    case 'thread_id':
      return 'thread:create';
    case 'run_id':
      return 'run:end';
    case 'table_id':
      return 'table_entry:update';
    default:
      return undefined;
  }
}

function validateIdForEvent(
  field: (typeof ID_FIELDS)[number] | undefined,
  eventName: string | undefined
): void {
  if (!field) return;
  const allowed: Record<(typeof ID_FIELDS)[number], (event: string) => boolean> = {
    message_id: (event) => event === 'message:create',
    thread_id: (event) => event === 'thread:create',
    agent_id: (event) => event.startsWith('agent:'),
    run_id: (event) => event === 'run:end',
    table_id: (event) => event.startsWith('table_entry:'),
  };
  if (!eventName) {
    throw new Error(`event_name is required with ${field}`);
  }
  if (!allowed[field](eventName)) {
    throw new Error(`${field} cannot resolve ${eventName}`);
  }
}

export default execute;
