import { HOOK_EVENT_NAMES, type HookEventName } from '@snaglet/sdk';
import { validateWorkspaceItemName } from '@desktop/utils/workspaceItemName';
import { safeJsonParse } from '@snaglet/shared/utils';

export { HOOK_EVENT_NAMES };
export type { HookEventName };

export const HOOK_TRIGGER_LABELS: Record<HookEventName, string> = {
  'schedule:fire': 'Schedule fired',
  'message:create': 'Message created',
  'thread:create': 'Thread created',
  'run:end': 'Agent run ended',
  'table_entry:create': 'Table entry created',
  'table_entry:update': 'Table entry updated',
  'table_entry:delete': 'Table entry deleted',
  'table_entry:occurrence': 'Repeating row occurrence',
  'agent:create': 'Agent created',
  'agent:update': 'Agent updated',
  'agent:delete': 'Agent deleted',
  'doc:create': 'Document created',
  'doc:edit': 'Document edited',
  'doc:move': 'Document moved',
  'doc:rename': 'Document renamed',
  'container:create': 'Container created',
  'container:move': 'Container moved',
  'container:update': 'Container updated',
  'thread:move': 'Thread moved',
  'node:archive': 'Node archived',
  'node:restore': 'Node restored',
};

/**
 * The filter a new hook on a trigger starts with when none is given: an
 * occurrence hook reacts to done ones (a skip, move or undo is the same
 * event with another `action`).
 */
const HOOK_TRIGGER_TEMPLATE_FILTERS: Partial<
  Record<HookEventName, Readonly<Record<string, unknown>>>
> = {
  'table_entry:occurrence': { action: 'done' },
};

export function validateHookName(name: string): string | null {
  return validateWorkspaceItemName(name);
}

/** Initial code for a new hook. From then on, hook.ts owns all configuration. */
export function scaffoldHookTs(
  hookName: string,
  triggers: readonly HookEventName[] = ['message:create'],
  filterText = ''
): string {
  const name = hookName.trim() || 'my-hook';
  const onLiteral =
    triggers.length === 1
      ? `'${triggers[0]}'`
      : `[${triggers.map((trigger) => `'${trigger}'`).join(', ')}]`;
  let filterLine = '';
  if (filterText.trim()) {
    // Only used for a create-time scaffold; malformed optional hints are omitted.
    const filter = safeJsonParse<unknown>(filterText, null);
    if (filter && typeof filter === 'object' && !Array.isArray(filter)) {
      filterLine = `  filter: ${JSON.stringify(filter)},\n`;
    }
  } else if (triggers.length === 1) {
    const template = HOOK_TRIGGER_TEMPLATE_FILTERS[triggers[0]];
    if (template) filterLine = `  filter: ${JSON.stringify(template)},\n`;
  }
  return `import { defineHook, snaglet } from '@snaglet/sdk';

/** ${name} — hook.ts is the source of truth for triggers, schedules, and behavior. */
export default defineHook({
  on: ${onLiteral},
${filterLine}  // Optional durable time triggers:
  // schedule: [
  //   { every: 15, unit: 'minute' },
  //   { time: '09:00', timezone: 'America/Los_Angeles', weekdays: [1, 2, 3, 4, 5] },
  // ],
  async run(event) {
    await snaglet.log.info(\`${name} saw \${event.type}: \${JSON.stringify(event)}\`);
  },
});
`;
}
