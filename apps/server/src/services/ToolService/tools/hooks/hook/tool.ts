import { createCanonicalRouter } from '@server/services/ToolService/handlers/_shared/canonicalRouter';
import create from '@server/services/ToolService/handlers/hooks/hook-create';
import run from '@server/services/ToolService/handlers/hooks/hook-run';
import {
  disableHook,
  enableHook,
  setHookRunAs,
  updateHook,
} from '@server/services/ToolService/handlers/hooks/hook-manage';

export default createCanonicalRouter(
  {
    create: {
      handler: create,
      fields: ['name', 'description', 'events', 'hook_source'],
      required: ['name', 'description'],
    },
    run: {
      handler: run,
      fields: [
        'hook_id_or_name',
        'event_name',
        'message_id',
        'thread_id',
        'table_id',
        'entry_id',
        'agent_id',
        'run_id',
        'payload',
        'force',
      ],
      required: ['hook_id_or_name'],
    },
    update: {
      handler: updateHook,
      fields: ['name', 'hook_source'],
      required: ['name', 'hook_source'],
    },
    enable: { handler: enableHook, fields: ['name'], required: ['name'] },
    disable: { handler: disableHook, fields: ['name'], required: ['name'] },
    run_as: { handler: setHookRunAs, fields: ['name', 'run_as'], required: ['name'] },
  },
  'hook'
);
