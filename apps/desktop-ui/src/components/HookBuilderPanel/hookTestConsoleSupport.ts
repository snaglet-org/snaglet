/**
 * Pure helpers for the hook test console — kept React-free so the trigger
 * parsing, node-ref extraction, and schedule-event synthesis are
 * unit-testable on their own.
 */

import { NODE_HREF_SOURCE, parseNodeRef } from '@desktop/features/rich-markdown/renderer/nodeRef';
import { HOOK_EVENT_NAMES, type HookEventName } from './scaffold';

// Chip markdown (`[Title](href)` / `![](href)`) or a bare typed/pasted id.
// The chip-link branch accepts any paren-free href and lets parseNodeRef
// decide (agent chips carry bare slug hrefs like `[Clio](clio)` that the
// prefixed-id grammar can't see); the bare-text branch stays restricted to
// the canonical grammar so ordinary words never extract as ids.
const NODE_REF_RE = new RegExp(`!?\\[[^\\]]*\\]\\(([^()\\s]+)\\)|(${NODE_HREF_SOURCE})`, 'g');

export interface ExtractedNodeRef {
  /** Lowercased chip kind, e.g. 'message', 'doc', 'agent'. */
  kind: string;
  /** Bare id including its kind prefix, e.g. 'message-1785…-ab12c'. */
  id: string;
}

/**
 * Every workspace-node reference in a chip-editable value, in order,
 * de-duplicated by id, with the chip kind preserved so callers can check
 * "is this actually a message?" before a run.
 */
export function extractNodeRefs(value: string): ExtractedNodeRef[] {
  const refs: ExtractedNodeRef[] = [];
  for (const match of value.matchAll(NODE_REF_RE)) {
    const href = match[1] ?? match[2];
    if (!href) continue;
    const ref = parseNodeRef(href);
    if (ref && !refs.some((seen) => seen.id === ref.id)) {
      refs.push({ kind: ref.kind, id: ref.id });
    }
  }
  return refs;
}

/**
 * Every workspace-node id referenced in a chip-editable value, in order,
 * de-duplicated. These are what `POST /api/hooks/:name/run` resolves into
 * real lifecycle payloads.
 */
export function extractNodeIds(value: string): string[] {
  return extractNodeRefs(value).map((ref) => ref.id);
}

// Trigger detection — parse `on:` (and a live `schedule:`) straight out of
// the EDITOR's code so the console's inputs track what the hook actually
// subscribes to, unsaved edits included. The server's declared metadata
// stays the runtime authority (the run flow re-checks); this is the UI's
// fast path.

export interface ParsedHookTriggers {
  /** Recognized event names inside `on:`, in code order, de-duplicated. */
  events: HookEventName[];
  /** True when an UNcommented `schedule:` array is present. */
  hasSchedule: boolean;
}

const KNOWN_EVENTS: ReadonlySet<string> = new Set(HOOK_EVENT_NAMES);

// Good enough for trigger detection; a `//` inside a string literal would
// also be stripped, but `on:`/`schedule:` config lines don't contain URLs.
const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

export function parseTriggersFromCode(code: string): ParsedHookTriggers {
  const stripped = stripComments(code);
  const events: HookEventName[] = [];
  // `on: 'message:create'` | `on: ["a", 'b']` — first `on:` wins, matching
  // how defineHook reads the config object.
  const onMatch = stripped.match(/\bon\s*:\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`)/);
  if (onMatch) {
    // Event names are `kind:verb`, kind may carry an underscore (table_entry).
    for (const quoted of onMatch[1].matchAll(/['"`]([a-z_:-]+)['"`]/g)) {
      const name = quoted[1];
      if (KNOWN_EVENTS.has(name) && !events.includes(name as HookEventName)) {
        events.push(name as HookEventName);
      }
    }
  }
  return { events, hasSchedule: /\bschedule\s*:\s*\[/.test(stripped) };
}

// Per-trigger test inputs — what each event needs to be mocked. The server
// resolves a real entity id into the exact payload the live event would
// deliver (resolveHookInvocation.ts), so the console only has to collect
// the right kind of id per trigger:
//   - schedule:fire     nothing — a due-now payload is synthesized
//   - message:create    a message (chip or pasted id)
//   - thread:create     a thread
//   - table_entry:*     a table id + an entry id (rows aren't workspace nodes);
//                       occurrence replays the row's newest logged occurrence
//   - agent:*           an agent
//   - run:end           a run id (runs aren't workspace nodes — plain text)

export type TriggerParamSpec =
  | { param: 'none'; hint: string }
  | {
      param: 'node';
      /** Chip kinds (parseNodeRef vocabulary) this event accepts. */
      nodeKinds: readonly string[];
      label: string;
      hint: string;
      placeholder: string;
    }
  | { param: 'id'; label: string; hint: string; placeholder: string }
  | {
      /** Two plain ids: the Database table and the entry in it. */
      param: 'table-entry';
      tableLabel: string;
      entryLabel: string;
      hint: string;
      tablePlaceholder: string;
      entryPlaceholder: string;
    };

export const TRIGGER_PARAM_SPECS: Record<HookEventName, TriggerParamSpec> = {
  'schedule:fire': {
    param: 'none',
    hint: 'No inputs needed — fires a due-now schedule payload (scheduledFor defaults to now).',
  },
  'message:create': {
    param: 'node',
    nodeKinds: ['message'],
    label: 'Message ID',
    hint: "Messages can't be dragged from the workspace — copy a message ID and paste it here. The run delivers the exact payload the real message:create event emits for it.",
    placeholder: 'Copy a message ID and paste it here…',
  },
  'thread:create': {
    param: 'node',
    nodeKinds: ['thread'],
    label: 'Thread ID',
    hint: 'Drag a thread from the workspace tree, @-mention it, or paste its ID — resolved into the real thread:create payload.',
    placeholder: 'Drag a thread here or paste a thread ID…',
  },
  'table_entry:create': {
    param: 'table-entry',
    tableLabel: 'Table ID',
    entryLabel: 'Entry ID',
    hint: 'Paste a Database table id and the id of one of its entries — resolved into the real table_entry:create payload.',
    tablePlaceholder: 'table-…',
    entryPlaceholder: 'entry UUID…',
  },
  'table_entry:update': {
    param: 'table-entry',
    tableLabel: 'Table ID',
    entryLabel: 'Entry ID',
    hint: "Paste a Database table id and the id of one of its entries — the sample lists each set field in the event's changes (from null to its current value). A task is a table row, so this is the status-changed trigger.",
    tablePlaceholder: 'table-…',
    entryPlaceholder: 'entry UUID…',
  },
  'table_entry:delete': {
    param: 'table-entry',
    tableLabel: 'Table ID',
    entryLabel: 'Entry ID',
    hint: 'Paste a Database table id and the id of one of its entries — resolved into a table_entry:delete payload naming that entry.',
    tablePlaceholder: 'table-…',
    entryPlaceholder: 'entry UUID…',
  },
  'table_entry:occurrence': {
    param: 'table-entry',
    tableLabel: 'Table ID',
    entryLabel: 'Entry ID',
    hint: "Paste a Database table id and the id of a repeating row — the sample replays the row's newest logged occurrence (done, skipped or moved) as a table_entry:occurrence payload, with the repeat as it stands now.",
    tablePlaceholder: 'table-…',
    entryPlaceholder: 'entry UUID…',
  },
  'agent:create': {
    param: 'node',
    nodeKinds: ['agent'],
    label: 'Agent ID',
    hint: 'Paste an agent ID (e.g. clio) or @-mention the agent — resolved into the real agent:create payload.',
    placeholder: 'Paste an agent ID here…',
  },
  'agent:update': {
    param: 'node',
    nodeKinds: ['agent'],
    label: 'Agent ID',
    hint: 'Paste an agent ID (e.g. clio) or @-mention the agent — the mock update reports changed: ["manual-test"].',
    placeholder: 'Paste an agent ID here…',
  },
  'agent:delete': {
    param: 'node',
    nodeKinds: ['agent'],
    label: 'Agent ID',
    hint: 'Paste an agent ID (e.g. clio) or @-mention the agent — resolved into the real agent:delete payload.',
    placeholder: 'Paste an agent ID here…',
  },
  'doc:create': {
    param: 'node',
    nodeKinds: ['doc'],
    label: 'Document ID',
    hint: 'Drag a document from the workspace tree or paste its ID — resolved into the real doc:create payload.',
    placeholder: 'Drag a document here or paste a document ID…',
  },
  'doc:edit': {
    param: 'node',
    nodeKinds: ['doc'],
    label: 'Document ID',
    hint: 'Drag a document from the workspace tree or paste its ID — resolved into the real doc:edit payload.',
    placeholder: 'Drag a document here or paste a document ID…',
  },
  'doc:move': {
    param: 'node',
    nodeKinds: ['doc'],
    label: 'Document ID',
    hint: "Drag a document or paste its ID — its latest placement is resolved into the event's move payload.",
    placeholder: 'Drag a document here or paste a document ID…',
  },
  'doc:rename': {
    param: 'node',
    nodeKinds: ['doc'],
    label: 'Document ID',
    hint: 'Drag a document or paste its ID — resolved into the real doc:rename payload.',
    placeholder: 'Drag a document here or paste a document ID…',
  },
  'container:create': {
    param: 'node',
    nodeKinds: ['container', 'project'],
    label: 'Container ID',
    hint: 'Drag a container from the workspace tree or paste its ID — resolved into the real container:create payload.',
    placeholder: 'Drag a container here or paste a container ID…',
  },
  'container:move': {
    param: 'node',
    nodeKinds: ['container', 'project'],
    label: 'Container ID',
    hint: "Drag a container or paste its ID — its latest placement is resolved into the event's move payload.",
    placeholder: 'Drag a container here or paste a container ID…',
  },
  'container:update': {
    param: 'node',
    nodeKinds: ['container', 'project'],
    label: 'Container ID',
    hint: 'Drag a container or paste its ID — resolved into the real container:update payload.',
    placeholder: 'Drag a container here or paste a container ID…',
  },
  'thread:move': {
    param: 'node',
    nodeKinds: ['thread'],
    label: 'Thread ID',
    hint: "Drag a thread or paste its ID — its latest project change is resolved into the event's move payload (fromProjectId / toProjectId).",
    placeholder: 'Drag a thread here or paste a thread ID…',
  },
  'node:archive': {
    param: 'node',
    nodeKinds: ['doc', 'container', 'project', 'thread'],
    label: 'Archived root ID',
    hint: 'Provide the root node of one archive action — the server resolves its archived cohort into one node:archive payload.',
    placeholder: 'Drag the archived root here or paste its ID…',
  },
  'node:restore': {
    param: 'node',
    nodeKinds: ['doc', 'container', 'project', 'thread'],
    label: 'Restored root ID',
    hint: 'Provide the root node of one restore action — the server resolves its restored cohort into one node:restore payload.',
    placeholder: 'Drag the restored root here or paste its ID…',
  },
  'run:end': {
    param: 'id',
    label: 'Run ID',
    hint: "Paste a past agent run's id — status, agent, and thread are resolved from the run log.",
    placeholder: 'run id…',
  },
};

/**
 * The synthesized due-now `schedule:fire` payload the "Trigger now" button
 * delivers — shaped exactly like the scheduler's real fire event, using the
 * hook's real registered schedule id when one exists.
 */
export function buildScheduleFireEvent(scheduleId: string | null): Record<string, unknown> {
  return {
    scheduleId: scheduleId ?? 'test',
    runId: `test-${Date.now()}`,
    scheduledFor: new Date().toISOString(),
  };
}
