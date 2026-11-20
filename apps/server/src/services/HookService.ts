/**
 * HookService — centralized event hooks for database mutations.
 *
 * Usage:
 *   import { hooks } from '@server/services/HookService';
 *
 *   // Register a listener
 *   hooks.on('agent:delete', ({ id }) => { ... });
 *
 *   // Fire from service layer after a mutation
 *   hooks.emit('agent:delete', { id });
 */

import { EventEmitter } from 'events';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger, redactSecrets } from '../config/logger';
import { currentChainDepth } from '../realtime/runContext';
import { HOOKS_V2_EVENT_NAMES } from './hooks/events';
import { isHelperHookEvent, isKnownHelperHookEvent } from './hooks/helperEvents';

// Add new events here as the system grows.

export interface HookEventMap {
  // Durable schedules. A schedule can target one saved hook directly; this
  // event shape is also available to authored hook code for type-safe access.
  'schedule:fire': {
    scheduleId: string;
    runId: string;
    scheduledFor: string;
    agentId?: string;
    threadId?: string;
  };

  // Agents — the create payload carries the agent's full configuration
  // (built by customHooks/agentCreateEvent.ts, the single shared builder).
  'agent:create': {
    id: string;
    /** Who created the agent — the ambient actor at creation. */
    createdBy: { kind: 'agent' | 'user' | 'external' | 'system'; id?: string };
    name?: string;
    role?: string | null;
    identity?: string | null;
    providerId?: string | null;
    modelId?: string | null;
    systemPrompt?: string | null;
    /** Tool-access situation: mode + explicit allow/deny lists. */
    toolAccess?: {
      mode: string | null;
      allowList: string[] | null;
      denyList: string[] | null;
    };
    /** MCP server ids the agent is connected to. */
    mcpServers?: string[];
  };
  'agent:update': { id: string; changed: string[] };
  'agent:delete': { id: string };

  // Providers
  'provider:create': { id: string };
  'provider:update': { id: string };
  'provider:delete': { id: string };

  // Threads — the create payload carries the full creation context (built
  // by customHooks/threadCreateEvent.ts, the single shared builder).
  'thread:create': {
    id: string;
    title?: string | null;
    /** Who created the thread — the ambient actor at creation. */
    createdBy: { kind: 'agent' | 'user' | 'external' | 'system'; id?: string };
    /** First agent participant — kept for cheap equality filters. */
    agentId?: string;
    /** Full roster at creation time, in join order. Agent entries carry
     *  their effective model (thread override, else the agent's own
     *  config) and any per-thread system-prompt addendum. */
    participants: Array<{
      kind: 'agent' | 'user' | 'external';
      id?: string;
      providerId?: string | null;
      modelId?: string | null;
      systemPromptAddendum?: string | null;
    }>;
    /** Thread-level system prompt, when set. */
    systemPrompt?: string | null;
    dispatchMode?: string;
  };
  'thread:update': {
    id: string;
    /** Who performed the change — captured from the ambient actor. */
    updatedBy: { kind: 'agent' | 'user' | 'external' | 'system'; id?: string };
    /**
     * What changed, values omitted from the audit event: `thread.<field>`
     * paths for thread op update (e.g. `thread.title`), `add_agents` for thread
     * op add_agents, `remove_agents` for thread op remove_agents.
     */
    changed: string[];
    /** Agents this call added as participants (thread op add_agents). */
    participantAgentIds: string[];
    /** Agents this call removed from the thread (thread op remove_agents). */
    removedAgentIds: string[];
  };
  'thread:delete': { id: string };

  // Messages
  // `role: 'agent'` when spoken by an agent (persistUtterance), `'user'` for a
  // human-authored message. `agentId` present on agent messages so a hook can
  // run tools under that agent's permissions. `chars` (optional — populated
  // by the emit sites that track it) is the persisted message content's
  // length. It remains generic metadata for user-authored lifecycle hooks.
  'message:create': {
    id: string;
    threadId: string;
    role: 'user' | 'agent';
    agentId?: string;
    /** The persisted message content, verbatim — hooks react to what was
     *  actually said, not just that something was said. */
    text: string;
    chars?: number;
  };

  // Runs — an agent run finished (completed / failed / aborted).
  'run:end': {
    runId: string;
    agentId?: string;
    threadId?: string;
    status: 'completed' | 'failed' | 'aborted';
  };

  // Table entries — rows in a Database table. A task is a row, so a status
  // change is a field edit here (table_entry:update), not a doc move. Emitted
  // from the table write path (domains/tables), so UI edits, agent
  // table_write calls and the REST routes all fire them.
  'table_entry:create': { tableId: string; entryId: string; origin?: HookEventOrigin };
  'table_entry:update': {
    tableId: string;
    entryId: string;
    /** Fields whose value changed: the field key with the wire value before and after. */
    changes: TableEntryChange[];
    origin?: HookEventOrigin;
  };
  'table_entry:delete': { tableId: string; entryIds: string[]; origin?: HookEventOrigin };
  /**
   * One occurrence of a repeating row was acted on: done,
   * counted, skipped, moved, shifted, jumped past, or one of those undone.
   * One event per action, after commit: a Skip to upcoming is one event with
   * `count`, and a status set to done sends its `table_entry:update` first.
   */
  'table_entry:occurrence': TableEntryOccurrenceEvent;

  // Tools
  'tool:create': { id: string };
  'tool:update': { id: string };
  'tool:delete': { id: string };

  // Agent-tool assignments
  'agent_tool:assign': { agentId: string; toolIds: string[] };
  'agent_tool:remove': { agentId: string; toolId: string };

  // Provider model profiles
  'profile:create': { id: string; providerId: string; modelId: string };
  'profile:delete': { id: string };

  // Credentials
  'credential:create': { id: string; providerId: string };
  'credential:delete': { id: string };

  // Models
  'model:create': { id: string };
  'model:update': { id: string };
  'model:delete': { id: string };
  'doc:create': {
    id: string;
    title: string;
    parentContainerId: string | null;
    createdBy: string | null;
    origin?: HookEventOrigin;
  };
  'doc:edit': {
    id: string;
    editor: string | null;
    charsDelta: number;
    backupSnapshotId: string | null;
    origin?: HookEventOrigin;
  };
  'doc:move': {
    id: string;
    fromContainerId: string | null;
    toContainerId: string | null;
    origin?: HookEventOrigin;
  };
  'doc:rename': { id: string; oldTitle: string; newTitle: string; origin?: HookEventOrigin };
  'container:create': {
    id: string;
    name: string;
    category: string | null;
    parentId: string | null;
    origin?: HookEventOrigin;
  };
  'container:move': {
    id: string;
    fromParentId: string | null;
    toParentId: string | null;
    origin?: HookEventOrigin;
  };
  'container:update': { id: string; changed: string[]; origin?: HookEventOrigin };
  'thread:move': {
    id: string;
    /** Project the thread left (null = it was flat at workspace level). */
    fromProjectId: string | null;
    /** Project the thread joined (null = now flat). */
    toProjectId: string | null;
    /** @deprecated Equals fromProjectId; threads are not placed in containers. Scheduled for removal. */
    fromContainerId: string | null;
    /** @deprecated Equals toProjectId. Scheduled for removal. */
    toContainerId: string | null;
    origin?: HookEventOrigin;
  };
  'node:archive': NodeCohortEvent;
  'node:restore': NodeCohortEvent;

  // Hook chaining. Not on the authored @snaglet/sdk list (see hooks/events.ts).
  /** A hook run succeeded (failed and timed-out runs emit nothing). */
  'hook:finished': {
    runId: string;
    hookName: string;
    eventName: string;
    durationMs: number;
    chainDepth: number;
  };
  /** A custom signal emitted from hook or tool code (`snaglet.emit`). */
  'hook:signal': {
    name: string;
    data: unknown;
    hookName: string | null;
    agentId: string | null;
    chainDepth: number;
  };
}

interface HookEventOrigin {
  kind: 'hook';
  hookName: string;
}

/** What happened to the occurrence. */
type TableEntryOccurrenceAction = 'done' | 'skipped' | 'moved' | 'shifted' | 'jumped' | 'undone';

/**
 * `table_entry:occurrence`. Times (`occurrence`, `lastOccurrence`, `movedTo`,
 * `current`) are local wall times without an offset (`YYYY-MM-DD` for a date
 * field, `YYYY-MM-DDTHH:MM:SS` for a datetime), read in `tz` (IANA);
 * `current` and `ended` describe the repeat after the write. `entryName` is
 * the only row value carried.
 */
export interface TableEntryOccurrenceEvent {
  tableId: string;
  entryId: string;
  /** The repeating date field. */
  fieldId: string;
  /** The row's name ('' when it has none). */
  entryName: string;
  /**
   * done / skipped: a set day done or skipped; moved: one occurrence moved;
   * shifted: every upcoming one moved; jumped: an interval jumped to now
   * (nothing logged); undone: one of those taken back (`undoneAction`).
   */
  action: TableEntryOccurrenceAction;
  /** The occurrence acted on (a period's first day); the first one for a Skip to upcoming. */
  occurrence: string;
  /** The last occurrence covered: `occurrence` unless `count` > 1. */
  lastOccurrence: string;
  /** Occurrences covered: 1, or N for one Skip to upcoming (and its undo). */
  count: number;
  /** IANA zone the local times are in. */
  tz: string;
  /** moved: where it went (its own slot when moved back); shifted: where `occurrence` went. */
  movedTo: string | null;
  /** undone: the action taken back. */
  undoneAction: Exclude<TableEntryOccurrenceAction, 'undone'> | null;
  /** The occurrence the row is on after the write; null when it no longer repeats. */
  current: string | null;
  /** Whether the series has ended after the write (its last occurrence is done or skipped). */
  ended: boolean;
  /** The log row (`table_entry_occurrences`); the first of `logIds`; null when none was logged (shifted, jumped, a move back to its slot). */
  logId: string | null;
  /** Every log row covered, in order (N for a Skip to upcoming). */
  logIds: string[];
  /** action: a repeat action (row, calendar, agent, API); status: a status set to done; history: an undo or redo. */
  via: 'action' | 'status' | 'history';
  /** Who did it. */
  actor: { kind: 'user' | 'agent' | 'external' | 'system'; id: string };
  origin?: HookEventOrigin;
}
/** One changed field on a table entry: the field key and its wire values before/after. */
export interface TableEntryChange {
  field: string;
  from: unknown;
  to: unknown;
}
interface NodeCohortEvent {
  rootId: string;
  rootKind: string;
  cohortIds: string[];
  count: number;
  archivedBy: string | null;
  origin?: HookEventOrigin;
}

export type HookEvent = keyof HookEventMap;

/** One remembered emit: the redacted payload plus the depth it was emitted at. */
interface RecentHookEvent {
  event: HookEvent;
  payload: unknown;
  chainDepth: number;
  at: string;
}

/** Recent payloads kept per catalog event (in memory only; empty after a restart). */
export const RECENT_EVENTS_PER_NAME = 20;
const RECENT_STRING_MAX = 2000;
const RECENT_EVENT_SET: ReadonlySet<string> = new Set(HOOKS_V2_EVENT_NAMES);

/** Redact secrets in every string and clip long strings, so the ring stays small and safe. */
function redactForRing(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const clean = redactSecrets(value);
    return clean.length > RECENT_STRING_MAX ? `${clean.slice(0, RECENT_STRING_MAX)}…` : clean;
  }
  if (value === null || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => redactForRing(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactForRing(item, depth + 1);
  return out;
}

class HookService {
  private emitter = new EventEmitter();
  private readonly recentByEvent = new Map<HookEvent, RecentHookEvent[]>();

  constructor() {
    // Don't warn on many listeners — hooks can have lots of subscribers
    this.emitter.setMaxListeners(50);
  }

  on<E extends HookEvent>(event: E, handler: (payload: HookEventMap[E]) => void): this {
    this.emitter.on(event, handler);
    return this;
  }

  once<E extends HookEvent>(event: E, handler: (payload: HookEventMap[E]) => void): this {
    this.emitter.once(event, handler);
    return this;
  }

  off<E extends HookEvent>(event: E, handler: (payload: HookEventMap[E]) => void): this {
    this.emitter.off(event, handler);
    return this;
  }

  emit<E extends HookEvent>(event: E, payload: HookEventMap[E]): void {
    // Event name only — payloads can be huge (workspace docs, task configs)
    // and fire on every DB mutation. Listeners should log details themselves
    // when they care.
    logger.debug(`hook: ${event}`);
    if (RECENT_EVENT_SET.has(event)) this.remember(event, payload);
    this.emitter.emit(event, payload);
  }

  /**
   * The last `limit` (≤ 20) payloads of a catalog event, newest first, each
   * with the chain depth it was emitted at.
   * A subagent helper's own events are left out, as hooks never receive them.
   */
  recent(event: HookEvent, limit = RECENT_EVENTS_PER_NAME): RecentHookEvent[] {
    const ring = this.recentByEvent.get(event) ?? [];
    return ring
      .filter((entry) => !isKnownHelperHookEvent(entry.event, entry.payload))
      .slice(-Math.max(0, limit))
      .reverse();
  }

  private remember(event: HookEvent, payload: unknown): void {
    try {
      const ring = this.recentByEvent.get(event) ?? [];
      ring.push({
        event,
        payload: redactForRing(payload),
        chainDepth: currentChainDepth(),
        at: new Date().toISOString(),
      });
      if (ring.length > RECENT_EVENTS_PER_NAME)
        ring.splice(0, ring.length - RECENT_EVENTS_PER_NAME);
      this.recentByEvent.set(event, ring);
      // Learn now whether this is a helper's event, so recent() can leave it out.
      void isHelperHookEvent(event, payload).catch((err: unknown) =>
        logger.debug(`hook: could not classify ${event}: ${getErrorMessage(err)}`)
      );
    } catch (err) {
      // Remembering is best-effort; it must never break the emit site.
      logger.debug(`hook: could not remember ${event}: ${getErrorMessage(err)}`);
    }
  }

  /** Number of listeners for a given event (useful for diagnostics) */
  listenerCount(event: HookEvent): number {
    return this.emitter.listenerCount(event);
  }
}

export const hooks = new HookService();
