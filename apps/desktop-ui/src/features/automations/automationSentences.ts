/**
 * The Automations list reads each row as one sentence, "starts when → does":
 * "Every weekday at 9:00 AM → wake Test Agent A in Test thread" for a timed
 * automation, "When a table row is created or changed → run notify-on-done"
 * for a script. Timing words come from the one shared describer,
 * `describeAutomationWhen` (an automation's own `whenText`, a script's
 * declared schedules), so the list says what the pane, the grid, the
 * calendar and the agent tool say.
 */
import type { AutomationRecord, AutomationWhen } from '@snaglet/shared/types';
import { capitalize, describeAutomationWhen, isRecord } from '@snaglet/shared/utils';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const ISO_DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** "Every weekday at 9:00 AM → wake Test Agent A in Test thread". */
export function automationSentence(
  automation: Pick<AutomationRecord, 'whenText' | 'agentName' | 'threadTitle'>
): string {
  const agent = automation.agentName ?? 'an agent';
  const where = automation.threadTitle ? ` in ${automation.threadTitle}` : '';
  return `${capitalize(automation.whenText)} → wake ${agent}${where}`;
}

// Scripts

interface EventLabel {
  /** Who or what the event is about: "a table row". */
  subject: string;
  /** What happens to it: "is created" (an "is …" verb combines: "is created or changed"). */
  verb: string;
  /** A short past-tense label for a run log line: "Row created". */
  happened: string;
}

/** Plain words for the events a script can start on. */
const SCRIPT_EVENT_LABELS: Readonly<Record<string, EventLabel>> = {
  'schedule:fire': { subject: 'its schedule', verb: 'comes due', happened: 'Schedule' },
  'message:create': { subject: 'a message', verb: 'is sent', happened: 'Message sent' },
  'thread:create': { subject: 'a thread', verb: 'is created', happened: 'Thread created' },
  'thread:move': { subject: 'a thread', verb: 'is moved', happened: 'Thread moved' },
  'run:end': { subject: 'a run', verb: 'ends', happened: 'Run ended' },
  'table_entry:create': { subject: 'a table row', verb: 'is created', happened: 'Row created' },
  'table_entry:update': { subject: 'a table row', verb: 'is changed', happened: 'Row changed' },
  'table_entry:delete': { subject: 'a table row', verb: 'is deleted', happened: 'Row deleted' },
  'table_entry:occurrence': {
    subject: 'a table row',
    verb: 'comes due',
    happened: 'Row came due',
  },
  'agent:create': { subject: 'an agent', verb: 'is created', happened: 'Agent created' },
  'agent:update': { subject: 'an agent', verb: 'is changed', happened: 'Agent changed' },
  'agent:delete': { subject: 'an agent', verb: 'is deleted', happened: 'Agent deleted' },
  'doc:create': { subject: 'a doc', verb: 'is created', happened: 'Doc created' },
  'doc:edit': { subject: 'a doc', verb: 'is edited', happened: 'Doc edited' },
  'doc:move': { subject: 'a doc', verb: 'is moved', happened: 'Doc moved' },
  'doc:rename': { subject: 'a doc', verb: 'is renamed', happened: 'Doc renamed' },
  'container:create': {
    subject: 'a container',
    verb: 'is created',
    happened: 'Container created',
  },
  'container:move': { subject: 'a container', verb: 'is moved', happened: 'Container moved' },
  'container:update': {
    subject: 'a container',
    verb: 'is changed',
    happened: 'Container changed',
  },
  'node:archive': { subject: 'an item', verb: 'is archived', happened: 'Item archived' },
  'node:restore': { subject: 'an item', verb: 'is restored', happened: 'Item restored' },
  'hook:finished': { subject: 'a script', verb: 'finishes', happened: 'Script finished' },
  'hook:signal': { subject: 'a script', verb: 'sends a signal', happened: 'Signal' },
};

/** The plain words for one event; an unknown one is named as it is. */
export function scriptEventLabel(event: string): EventLabel {
  return (
    SCRIPT_EVENT_LABELS[event] ?? {
      subject: `the ${event} event`,
      verb: 'fires',
      happened: event,
    }
  );
}

/** "a, b or c" (a list of two or more joins its last with "or"). */
function orList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** "is created", "is changed" → "is created or changed"; others join whole. */
function joinVerbs(verbs: string[]): string {
  if (verbs.length > 1 && verbs.every((verb) => verb.startsWith('is '))) {
    return `is ${orList(verbs.map((verb) => verb.slice(3)))}`;
  }
  return orList(verbs);
}

/**
 * "When a table row is created or changed", "When a message is sent or a
 * run ends". Events about the same thing share it; null for no events.
 */
function scriptEventsSentence(events: readonly string[]): string | null {
  const bySubject = new Map<string, string[]>();
  for (const event of new Set(events)) {
    const { subject, verb } = scriptEventLabel(event);
    const verbs = bySubject.get(subject) ?? [];
    verbs.push(verb);
    bySubject.set(subject, verbs);
  }
  if (bySubject.size === 0) return null;
  const clauses = [...bySubject].map(([subject, verbs]) => `${subject} ${joinVerbs(verbs)}`);
  return `When ${orList(clauses)}`;
}

const UNIT_MS: Record<string, number> = {
  minute: MINUTE_MS,
  hour: HOUR_MS,
  day: DAY_MS,
  week: 7 * DAY_MS,
};

/**
 * A schedule a script declares (`{at}`, `{every, unit}` or `{time, timezone,
 * weekdays?}`, ISO weekdays 1 = Monday) as the automation timing it means,
 * for the shared describer; null for a shape it is not.
 */
function scheduleAsWhen(schedule: unknown, viewerTz: string): AutomationWhen | null {
  if (!isRecord(schedule)) return null;
  if (typeof schedule.at === 'string' && !Number.isNaN(Date.parse(schedule.at))) {
    return { kind: 'once', at: schedule.at, tz: viewerTz };
  }
  if (typeof schedule.every === 'number' && typeof schedule.unit === 'string') {
    const unit = UNIT_MS[schedule.unit];
    if (!unit || !(schedule.every > 0)) return null;
    return { kind: 'interval', everyMs: schedule.every * unit, tz: viewerTz };
  }
  if (typeof schedule.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
    const tz =
      typeof schedule.timezone === 'string' && schedule.timezone ? schedule.timezone : viewerTz;
    const days = Array.isArray(schedule.weekdays)
      ? [...new Set(schedule.weekdays)]
          .filter((day): day is number => Number.isInteger(day) && day >= 1 && day <= 7)
          .sort((a, b) => a - b)
      : [];
    const rrule =
      days.length === 0 || days.length === 7
        ? 'FREQ=DAILY'
        : `FREQ=WEEKLY;BYDAY=${days.map((day) => ISO_DAY_CODES[day - 1]).join(',')}`;
    return { kind: 'repeat', rrule, timeOfDay: schedule.time, startsOn: '2026-01-01', tz };
  }
  return null;
}

/** What a script's saved code declares (from its `/api/hooks/registry` row). */
export interface ScriptDeclaration {
  events: readonly string[];
  schedules: readonly unknown[];
}

/**
 * When a script starts, from what it declares: "When a run ends", "Every
 * 5 minutes", or both joined with "or". Null when nothing is known (the
 * script is not built yet, or its build failed).
 */
function scriptWhenSentence(
  declared: ScriptDeclaration | null | undefined,
  viewerTz: string
): string | null {
  if (!declared) return null;
  const parts = [
    scriptEventsSentence(declared.events),
    ...declared.schedules.map((schedule) => {
      const when = scheduleAsWhen(schedule, viewerTz);
      return when ? describeAutomationWhen(when, viewerTz) : 'on a schedule';
    }),
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return 'Only when run by hand';
  return capitalize(parts.join(', or '));
}

/** "When a run ends → run nightly-report"; just "Run nightly-report" while nothing is known. */
export function scriptSentence(
  name: string,
  declared: ScriptDeclaration | null | undefined,
  viewerTz: string = Intl.DateTimeFormat().resolvedOptions().timeZone
): string {
  const when = scriptWhenSentence(declared, viewerTz);
  return when ? `${when} → run ${name}` : `Run ${name}`;
}
