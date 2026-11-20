import type { SidebarCommand, SidebarSnapshot, SidebarError } from './sidebar';
/**
 * Real-time workspace event schema (wire format).
 *
 * These events are broadcast on the `workspace` WebSocket channel (see
 * `WS_PATH` in ./ws.ts) whenever a mutation occurs to one of the synced
 * surfaces:
 *
 *   1. Workspace tree  (docs, containers, threads)
 *   2. Threads          (rename, status, archive)
 *
 * Out of scope (do not add event types for these without explicit approval):
 *   - Feed posts, agent runs, memory writes
 *   - Tool registry sync (has its own path)
 *   - Collaborative editing (CRDT/OT)
 *
 * Payload shape rule:
 *   - `*.created` events carry a full snapshot of the new node
 *   - `*.updated` events carry the ID plus the changed fields only
 *   - `*.deleted` events carry only the ID
 *
 * Some client-side helpers use the name "library" internally; this wire
 * schema uses the `workspace.*` / `thread.*` discriminators.
 */

import type { WsMessage } from './ws';
import type { ContainerCategory } from '../constants/taxonomy';
import type { HookRunRecord } from './hooks';
import type { TableCatalogEntry } from './tables';
import type { NotificationRecord } from './notifications';
import type { ProjectIndexingRuntime } from './project-indexing';
import type { ThreadRunAlert } from './thread-notifications';

// Common envelope fields

/** Channel name on which all workspace events are broadcast. */
export const WORKSPACE_EVENT_CHANNEL = 'workspace' as const;

/**
 * Who caused an event.
 *
 * - `user`     — initiated by a logged-in user via HTTP/UI
 * - `agent`    — initiated by an agent run (tool call)
 * - `external` — initiated by an external MCP client through the /mcp
 *                surface. Unlike the other kinds, `actorId` is the members.id
 *                (external members have no agents/users principal row).
 * - `system`   — startup tasks, migrations, cron, anything not directly
 *                attributable. Default when no other actor context is present.
 */
export type ActorKind = 'user' | 'agent' | 'external' | 'system';

export interface Actor {
  actorId: string;
  actorKind: ActorKind;
  /** Optional display name for UI ("Patty renamed this"). */
  actorName?: string;
}

/**
 * Metadata present on every workspace event.
 *
 * `originClientId` lets a receiver identify its own echo (the WS connection
 * that originated the mutation). Echoes are not suppressed (applies are
 * idempotent); the field is there for diagnostics.
 */
export interface WorkspaceEventMeta {
  /** ISO-8601 timestamp the event was emitted on the server. */
  ts: string;
  actor: Actor;
  /** WS clientId of the connection that initiated this mutation, if any. */
  originClientId?: string;
}

// Surface 1: Workspace tree (docs, containers, threads-as-nodes, etc.)

/**
 * Kinds of nodes that can live in the workspace tree.
 *
 * Mirrors the server's node-kind taxonomy. Kept as a string literal union
 * (not an enum) so it stays structural and easy to extend.
 */
export type WorkspaceNodeKind = 'doc' | 'container' | 'thread' | 'project' | 'image';

/**
 * Full snapshot of a workspace tree node.
 *
 * Used as the payload for `workspace.created`. Fields are intentionally
 * conservative — only what the client needs to render the node in the tree
 * without an immediate refetch. Richer details are still fetched on demand.
 */
export interface WorkspaceNodeSnapshot {
  id: string;
  kind: WorkspaceNodeKind;
  title: string;
  parentId: string | null;
  /** Sort key within the parent. Server-defined string ordering. */
  sortKey?: string;
  /**
   * Container-only annotation, so the tree can render the category chip
   * without a refetch. Absent for non-container kinds and for containers with
   * no category. Additive — receivers that predate this field ignore it.
   */
  category?: ContainerCategory | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Patch describing a workspace tree node update.
 *
 * Only fields that actually changed are present. Receivers merge on top of
 * their cached snapshot. If a receiver has no cached snapshot (cold join
 * mid-session), it falls back to refetch.
 */
export interface WorkspaceNodePatch {
  id: string;
  /**
   * Kind of the node being patched. Required on the wire so cross-client
   * adapters can route to kind-scoped caches (e.g. dispatch a rename to the
   * thread store vs. the doc store) without a snapshot lookup.
   */
  kind: WorkspaceNodeKind;
  title?: string;
  parentId?: string | null;
  sortKey?: string;
  /** Container-only: present when category changed. Additive. */
  category?: ContainerCategory | null;
  /** Image-only searchable metadata. Additive; receivers may ignore it. */
  description?: string | null;
  tags?: string[];
  updatedAt: string;
}

export interface WorkspaceCreatedEvent extends WorkspaceEventMeta {
  type: 'workspace.created';
  node: WorkspaceNodeSnapshot;
}

export interface WorkspaceUpdatedEvent extends WorkspaceEventMeta {
  type: 'workspace.updated';
  patch: WorkspaceNodePatch;
}

export interface WorkspaceDeletedEvent extends WorkspaceEventMeta {
  type: 'workspace.deleted';
  id: string;
  /** Helpful for clients pruning kind-scoped caches. */
  kind: WorkspaceNodeKind;
}

/**
 * Archive / restore are first-class wire events (not folded into
 * `workspace.updated`) so clients can react with archive-specific UI without
 * inspecting patches. Archived nodes typically leave the active tree but
 * remain addressable.
 */
export interface WorkspaceArchivedEvent extends WorkspaceEventMeta {
  type: 'workspace.archived';
  id: string;
  kind: WorkspaceNodeKind;
  archivedAt: string;
}

export interface WorkspaceRestoredEvent extends WorkspaceEventMeta {
  type: 'workspace.restored';
  id: string;
  kind: WorkspaceNodeKind;
  /** Snapshot of restored node so clients can re-insert into the tree without a refetch. */
  node: WorkspaceNodeSnapshot;
}

/**
 * Dedicated doc-body event. Separate from `workspace.updated` so the common
 * rename/move case stays small, and so subscribers interested only in body
 * changes (e.g. open editors) can filter cheaply.
 *
 * `body` is the full new content, not a delta.
 */
export interface DocSavedEvent extends WorkspaceEventMeta {
  type: 'doc.saved';
  id: string;
  body: string;
  updatedAt: string;
  /**
   * members.id this save stamped as the doc's `last_edited_by` — the same
   * value `GET /api/docs/:id` returns as `lastEditedBy`, so a client can
   * refresh a doc's "Edited by" without a refetch. Optional and additive:
   * omitted when the save is unattributed (system / no member), and clients
   * that predate it ignore it.
   */
  lastEditedBy?: string;
}

/**
 * File-search coverage changed because an indexed file reference or a
 * content-addressed file embedding was added/removed. The payload is
 * deliberately global: one content hash may be referenced by several projects,
 * including satellite projects whose effective index lives under an owner.
 * Open project surfaces refetch their own cheap scoped aggregate.
 */
export interface FileEmbeddingCoverageChangedEvent extends WorkspaceEventMeta {
  type: 'file.embedding_coverage_changed';
}

/** A bounded folder scan finished using the project's current indexing rules. */
export interface FileIndexingImpactChangedEvent extends WorkspaceEventMeta {
  type: 'file.indexing_impact_changed';
  projectId: string;
  eligibleFiles: number;
  scannedEntries: number;
  capped: boolean;
}

/**
 * A project's indexing runtime changed: a reconcile scan started/finished, a
 * backfill made progress, a clear began or completed, or an operation failed.
 * Carries the full runtime snapshot so the UI can render live status without a
 * refetch. Worker preference and coverage changes are not in this event —
 * they arrive via `file.embedding_coverage_changed` + a status refetch.
 */
export interface ProjectIndexingStatusChangedEvent extends WorkspaceEventMeta {
  type: 'file.indexing_status_changed';
  projectId: string;
  runtime: ProjectIndexingRuntime;
}

// Surface 2: Threads

export type ThreadStatus = 'active' | 'archived';

/**
 * Full snapshot of a thread, carried by `thread.created`.
 *
 * `projectId` is the thread's project scope (a container with
 * `category = 'project'`), or null for a flat, workspace-level thread. Threads
 * have no folder placement; on the tree surface (`workspace.*` events with
 * `kind: 'thread'`) `parentId` carries this same project id.
 */
export interface ThreadSnapshot {
  id: string;
  title: string;
  status: ThreadStatus;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Changed thread fields, carried by `thread.updated`.
 *
 * A thread moving between projects (or to/from flat) is not a separate event:
 * it rides `thread.updated` with `projectId` present — the same patch
 * contract every other field uses, so receivers merge it into their cached
 * snapshot without a kind-specific handler. The tree surface mirrors it as a
 * `workspace.updated` patch whose `parentId` is the new project id.
 */
export interface ThreadPatch {
  id: string;
  title?: string;
  status?: ThreadStatus;
  /** Present when the thread changed project scope; null = now flat. */
  projectId?: string | null;
  updatedAt: string;
}

export interface ThreadCreatedEvent extends WorkspaceEventMeta {
  type: 'thread.created';
  thread: ThreadSnapshot;
}

export interface ThreadUpdatedEvent extends WorkspaceEventMeta {
  type: 'thread.updated';
  patch: ThreadPatch;
}

export interface ThreadDeletedEvent extends WorkspaceEventMeta {
  type: 'thread.deleted';
  id: string;
}

/**
 * Run-lifecycle events: an agent run started/finished on a thread.
 * Emitted by ActiveRunTracker when a thread's active-session slot flips, so
 * any client surface (workspace tree, tab badges) can show live activity
 * without subscribing to the thread's chat channel.
 */
export interface ThreadRunStartedEvent extends WorkspaceEventMeta {
  type: 'thread.run_started';
  threadId: string;
}

export interface ThreadRunFinishedEvent extends WorkspaceEventMeta {
  type: 'thread.run_finished';
  threadId: string;
}

/**
 * A run ended in a thread whose own notification settings asked to be told
 * (`thread_notification_settings`): alert the user — OS banner plus the
 * chosen sound — the way a calendar reminder does.
 *
 * Separate from `notification.created` on purpose: that event owns the tray,
 * and a `run_completed` entry deliberately raises no OS banner. This one
 * carries only the alert, so no second tray entry appears; `alert.notificationId`
 * points at the tray notification it accompanies.
 */
export interface ThreadRunAlertEvent extends WorkspaceEventMeta {
  type: 'thread.run_alert';
  alert: ThreadRunAlert;
}

// Surface 3: Agent work (active runs + hook executions)

/** What kind of work an agent is doing right now. */
export type ActiveWorkKind = 'thread-run' | 'hook-run';

/**
 * One unit of in-flight agent work. `thread-run` items are live agent turns
 * (one per run — a multi-agent wave on one thread produces one item per
 * agent); `hook-run` items are executing hook child processes.
 *
 * In-memory only on the server (ActiveWorkRegistry) — a restart clears the
 * set, so a stale item can never outlive the process that reported it.
 */
export interface ActiveWorkItem {
  /** Unique id — the run id for thread runs, a per-spawn id for hook runs. */
  id: string;
  kind: ActiveWorkKind;
  /** Acting agent, when known (hook runs outside an agent turn have none). */
  agentId?: string;
  agentName?: string;
  /** Thread the work is happening in, when applicable. */
  threadId?: string;
  threadTitle?: string;
  /** Hook folder name, for `hook-run` items. */
  hookName?: string;
  /** ISO timestamp of when the work actually started executing. */
  startedAt: string;
}

export interface AgentWorkStartedEvent extends WorkspaceEventMeta {
  type: 'agent.work_started';
  item: ActiveWorkItem;
}

export interface AgentWorkFinishedEvent extends WorkspaceEventMeta {
  type: 'agent.work_finished';
  id: string;
}

/**
 * An agent changed. **An invalidation signal, not a data payload.**
 *
 * Agents are actors, not workspace nodes, so they do not travel on the
 * `workspace.updated` node patch — this is their own event.
 *
 * It deliberately carries NO agent fields. Shipping `role` (or a whole agent
 * snapshot) would create a second source of truth that can disagree with the
 * row the receiver already holds, and every future field would have to be
 * added here too. `changed` names which keys moved so a receiver can decide
 * whether it cares; the authoritative values come from a refetch.
 */
export interface AgentUpdatedEvent extends WorkspaceEventMeta {
  type: 'agent.updated';
  agentId: string;
  /**
   * Accepted field names that actually changed, e.g. `['role']` — or one of
   * the lifecycle markers `'created'` / `'deleted'`, which signal that the
   * agent roster itself changed shape and any cached roster must refetch.
   * `'skills'` names the agent's general skills, which live outside the row.
   */
  changed: string[];
  /**
   * The row's revision after the write: the agent's `updatedAt` exactly as
   * the REST API returns it. A receiver that already holds this revision
   * (its own save's echo) has nothing to refetch. Absent when the write did
   * not touch the agent row or the emitter has no row at hand; a receiver
   * then refetches.
   */
  updatedAt?: string;
}

// Surface 4: Hook execution ledger

/** A durable hook run was created and has begun executing. */
export interface HookRunStartedEvent extends WorkspaceEventMeta {
  type: 'hook.run_started';
  run: HookRunRecord;
}

/** A durable hook run reached its terminal status. */
export interface HookRunFinishedEvent extends WorkspaceEventMeta {
  type: 'hook.run_finished';
  run: HookRunRecord;
}

export type HookRunsChangedReason = 'clear' | 'hook-delete' | 'retention' | 'thread-delete';

/** Durable hook history changed; consumers must evict and refresh these hooks. */
export interface HookRunsChangedEvent extends WorkspaceEventMeta {
  type: 'hook.runs_changed';
  hookNames: string[];
  reason: HookRunsChangedReason;
}

/** A hook's automatic execution was turned on or off (UI, CLI or another window). */
export interface HookEnabledChangedEvent extends WorkspaceEventMeta {
  type: 'hook.enabled_changed';
  hookName: string;
  enabled: boolean;
}

/**
 * The registry saw these hooks change: a build started or ended (ready or
 * failed), a new folder was registered, or a folder went away. Lists re-read
 * `/api/hooks` and `/api/hooks/registry`.
 */
export interface HookRegistryChangedEvent extends WorkspaceEventMeta {
  type: 'hook.registry_changed';
  hookNames: string[];
}

// Surface 5: Notifications

/** A new notification was created. */
export interface NotificationCreatedEvent extends WorkspaceEventMeta {
  type: 'notification.created';
  notification: NotificationRecord;
}

/**
 * A notification was dismissed: by the user, or by the server because the
 * agent ask it announced (a tool-permission prompt, a Triage question)
 * settled. Every client drops it from its tray and closes its OS banner.
 */
export interface NotificationDismissedEvent extends WorkspaceEventMeta {
  type: 'notification.dismissed';
  id: string;
}

// Surface 7: Database tables (table_catalog — not workspace nodes)
//
// Catalog entries are table identities, not tree nodes, so they never ride
// `workspace.*`. Broadcast: every Database sidebar and open table pane patches
// its catalog list in place.

/** A custom table was created and registered in the catalog. */
export interface TableCreatedEvent extends WorkspaceEventMeta {
  type: 'table.created';
  table: TableCatalogEntry;
}

/** A custom table's display name changed (catalog id and storage unchanged). */
export interface TableUpdatedEvent extends WorkspaceEventMeta {
  type: 'table.updated';
  table: TableCatalogEntry;
}

/** Committed field metadata or physical schema changed; readers reload the definition. */
export interface TableFieldsChangedEvent extends WorkspaceEventMeta {
  type: 'table.fields.changed';
  tableId: string;
}

/**
 * A committed write to one or more of a table's entries, one event per batch.
 * Table- and page-scoped readers reload their bounded page; entry-scoped ones
 * (an open row, its repeats) check whether their entry is named: in
 * `entryIds`, or every entry with `allEntries`.
 */
export interface TableEntriesChangedEvent extends WorkspaceEventMeta {
  type: 'table.entries.changed';
  tableId: string;
  /** The batch's first entry (all an older reader looks at). */
  entryId: string;
  /** Every entry the batch wrote, `entryId` first. Absent with `allEntries`. */
  entryIds?: string[];
  /** Too many entries to list (over 500): any of the table's entries may have changed. */
  allEntries?: true;
}

/**
 * A custom table was archived or deleted (deleted tables stay undoable from
 * history). Sidebars drop it; open panes show it as archived or gone.
 */
export interface TableRemovedEvent extends WorkspaceEventMeta {
  type: 'table.removed';
  tableId: string;
  state: 'archived' | 'deleted';
}

/** An archived or deleted table came back (restore, or undo/redo); sidebars add it again. */
export interface TableRestoredEvent extends WorkspaceEventMeta {
  type: 'table.restored';
  table: TableCatalogEntry;
}

/**
 * An actor's table undo history changed (a step was recorded, undone or
 * redone). Clients showing that stack refresh their Undo/Redo state.
 */
export interface TableHistoryChangedEvent extends WorkspaceEventMeta {
  type: 'table.history.changed';
  stack: { kind: ActorKind; id: string };
}

/**
 * A provider's model catalog changed: models were imported (a discovery pass
 * after a key was saved, a bulk import, an agent's `model` add), a model's
 * limits or name were edited, or a model was removed. Clients showing model
 * lists re-read them; the event carries no rows.
 */
export interface ModelsChangedEvent extends WorkspaceEventMeta {
  type: 'models.changed';
  providerId: string;
}

// Discriminated union + helpers

export type WorkspaceEvent =
  | WorkspaceCreatedEvent
  | WorkspaceUpdatedEvent
  | WorkspaceDeletedEvent
  | WorkspaceArchivedEvent
  | WorkspaceRestoredEvent
  | DocSavedEvent
  | FileEmbeddingCoverageChangedEvent
  | FileIndexingImpactChangedEvent
  | ProjectIndexingStatusChangedEvent
  | ThreadCreatedEvent
  | ThreadUpdatedEvent
  | ThreadDeletedEvent
  | ThreadRunStartedEvent
  | ThreadRunFinishedEvent
  | ThreadRunAlertEvent
  | AgentWorkStartedEvent
  | AgentWorkFinishedEvent
  | AgentUpdatedEvent
  | HookRunStartedEvent
  | HookRunFinishedEvent
  | HookRunsChangedEvent
  | HookEnabledChangedEvent
  | HookRegistryChangedEvent
  | TableCreatedEvent
  | TableUpdatedEvent
  | TableFieldsChangedEvent
  | TableEntriesChangedEvent
  | TableRemovedEvent
  | TableRestoredEvent
  | TableHistoryChangedEvent
  | ModelsChangedEvent
  | NotificationCreatedEvent
  | NotificationDismissedEvent;

export type WorkspaceEventType = WorkspaceEvent['type'];

/**
 * Per-type extractor — saves callers writing `Extract<...>` boilerplate.
 *
 *   const handler = (e: WorkspaceEventOfType<'doc.saved'>) => { ... }
 */
export type WorkspaceEventOfType<T extends WorkspaceEventType> = Extract<
  WorkspaceEvent,
  { type: T }
>;

/**
 * Type guard: is the given value a WorkspaceEvent?
 *
 * Defensive — only validates discriminator presence and shape of `actor` +
 * `ts`. Per-variant payload validation is the caller's responsibility (and
 * is usually unnecessary because the server is the only emitter).
 */
export function isWorkspaceEvent(value: unknown): value is WorkspaceEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string') return false;
  if (typeof v.ts !== 'string') return false;
  const actor = v.actor as Record<string, unknown> | undefined;
  if (!actor || typeof actor.actorId !== 'string') return false;
  if (
    actor.actorKind !== 'user' &&
    actor.actorKind !== 'agent' &&
    actor.actorKind !== 'external' &&
    actor.actorKind !== 'system'
  ) {
    return false;
  }
  // Discriminator must be one of the known types.
  //
  // This list is hand-maintained and does not derive from the union above —
  // adding a member to `WorkspaceEvent` without adding it here compiles fine
  // and then silently drops that event at every receiver. Add both.
  return (
    v.type === 'workspace.created' ||
    v.type === 'workspace.updated' ||
    v.type === 'workspace.deleted' ||
    v.type === 'workspace.archived' ||
    v.type === 'workspace.restored' ||
    v.type === 'doc.saved' ||
    v.type === 'file.embedding_coverage_changed' ||
    v.type === 'file.indexing_impact_changed' ||
    v.type === 'file.indexing_status_changed' ||
    v.type === 'thread.created' ||
    v.type === 'thread.updated' ||
    v.type === 'thread.deleted' ||
    v.type === 'thread.run_started' ||
    v.type === 'thread.run_finished' ||
    v.type === 'thread.run_alert' ||
    v.type === 'agent.work_started' ||
    v.type === 'agent.work_finished' ||
    v.type === 'agent.updated' ||
    v.type === 'hook.run_started' ||
    v.type === 'hook.run_finished' ||
    v.type === 'hook.runs_changed' ||
    v.type === 'hook.enabled_changed' ||
    v.type === 'hook.registry_changed' ||
    v.type === 'notification.created' ||
    v.type === 'notification.dismissed' ||
    v.type === 'table.created' ||
    v.type === 'table.updated' ||
    v.type === 'table.fields.changed' ||
    v.type === 'table.entries.changed' ||
    v.type === 'table.removed' ||
    v.type === 'table.restored' ||
    v.type === 'table.history.changed' ||
    v.type === 'models.changed'
  );
}

/**
 * Wire envelope: a WsMessage carrying a WorkspaceEvent payload.
 *
 * The server's emit helper produces values of this shape; the client adapter
 * narrows `msg.payload` via `isWorkspaceEvent` before dispatching.
 */
export type WorkspaceEventMessage = WsMessage<WorkspaceEvent> & {
  channel: typeof WORKSPACE_EVENT_CHANNEL;
  type: WorkspaceEventType;
};

/*
 * UI navigation surface (addressed transport, not the broadcast funnel)
 *
 * These events drive agent-driven UI navigation. A WorkspaceEvent is broadcast
 * to every subscriber of the `workspace` channel, whereas a Ui* event is sent
 * to a single user's live client(s) via wsService.sendToClient. They live on
 * their own `ui` channel and their own `UiEvent` union, not folded into
 * WorkspaceEvent, so the broadcast/addressed boundary is enforced by the type.
 *
 *   server -> client : ui.navigate_pane, ui.request_pane_layout
 *   client -> server : ui.pane_layout_response, ui.register_client
 */

/** Channel name for addressed UI navigation traffic. */
export const UI_EVENT_CHANNEL = 'ui' as const;

/**
 * What to open in a pane. Discriminated on `kind`. Field names use the wire
 * (camelCase) convention; tools translate their snake_case params into this
 * shape before emitting. Extending this union is additive — new routable node
 * kinds slot in without breaking the contract.
 */
export type PaneNavigationTarget =
  | { kind: 'doc'; docId: string; focusMessageId?: string }
  | { kind: 'thread'; threadId: string; agentId?: string; focusMessageId?: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'container'; containerId: string }
  | { kind: 'image'; imageId: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'tool'; toolId: string }
  | { kind: 'providers'; providerId?: string };

export type PaneNavigationMode = 'split' | 'replace';
export type PaneSplitZone = 'top' | 'bottom' | 'left' | 'right';

/**
 * A full navigation command: where and how (optional pane + mode) plus what (target).
 * Default mode is split so agent-opened context preserves the user's current
 * chat. In replace mode, `paneKey` null/undefined means the UI picks an
 * available pane and avoids the active thread where possible.
 */
export interface PaneNavigationCommand {
  paneKey?: string | null;
  mode?: PaneNavigationMode;
  splitZone?: PaneSplitZone;
  /** Fraction (0..1) allocated to the new pane when mode='split'. */
  newPaneRatio?: number;
  target: PaneNavigationTarget;
}

/**
 * One pane in the user's split layout, as serialized by the client in
 * response to `ui.request_pane_layout`. `selection` mirrors the client's
 * DetailSelection but flattened to the minimal shape an agent needs to decide
 * which pane to target: kind + id + human title.
 */
export interface SerializedPane {
  /** Unique, stable key for this pane (client-assigned). */
  key: string;
  /** Pane size as a fraction (0..1) of its parent split. */
  ratio: number;
  /** True iff this pane holds the thread the user is actively chatting in. */
  isActiveThread: boolean;
  selection: SerializedPaneSelection;
}

export type SerializedPaneSelection =
  | { kind: 'doc'; docId: string; title: string }
  | { kind: 'thread'; threadId: string; agentId?: string; title: string }
  | { kind: 'project'; projectId: string; title: string }
  | { kind: 'container'; containerId: string; title: string }
  | { kind: 'image'; imageId: string; title: string }
  | { kind: 'providers'; title: string }
  | { kind: 'mcp'; title: string }
  | { kind: 'empty' };

/** Snapshot of the user's whole split layout. */
export interface PaneLayoutSnapshot {
  panes: SerializedPane[];
}

/** server -> client: command a pane to navigate. */
export interface UiNavigatePaneEvent {
  type: 'ui.navigate_pane';
  ts: string;
  actor: Actor;
  paneKey?: string | null;
  mode?: PaneNavigationMode;
  splitZone?: PaneSplitZone;
  newPaneRatio?: number;
  target: PaneNavigationTarget;
}

/**
 * server -> client: ask the client to report its current pane layout.
 * `requestId` correlates the eventual `ui.pane_layout_response`.
 */
export interface UiRequestPaneLayoutEvent {
  type: 'ui.request_pane_layout';
  ts: string;
  actor: Actor;
  requestId: string;
}

/**
 * client -> server: the live layout snapshot answering a request.
 * `requestId` echoes the request that triggered it.
 */
export interface UiPaneLayoutResponseEvent {
  type: 'ui.pane_layout_response';
  requestId: string;
  layout: PaneLayoutSnapshot;
}

/**
 * client -> server: announce which user this connection belongs to, so the
 * server can map userId -> live clientId(s) for addressed navigation. Sent
 * once after the connection is established (and after the client learns its
 * own clientId from the `connected` message).
 */
export interface UiRegisterClientEvent {
  type: 'ui.register_client';
  userId: string;
}

export interface UiSidebarRequestEvent {
  type: 'ui.sidebar_request';
  ts: string;
  actor: Actor;
  requestId: string;
  command: SidebarCommand;
}
export interface UiSidebarResponseEvent {
  type: 'ui.sidebar_response';
  requestId: string;
  state: SidebarSnapshot;
  error?: SidebarError;
}

/** server -> client events on the `ui` channel. */
export type UiServerEvent = UiNavigatePaneEvent | UiRequestPaneLayoutEvent | UiSidebarRequestEvent;

/** client -> server events on the `ui` channel. */
export type UiClientEvent =
  | UiPaneLayoutResponseEvent
  | UiRegisterClientEvent
  | UiSidebarResponseEvent;

/** All events on the `ui` channel, either direction. */
export type UiEvent = UiServerEvent | UiClientEvent;

export type UiEventType = UiEvent['type'];

/** Runtime guard: is this an event on the UI navigation surface? */
export function isUiEvent(value: unknown): value is UiEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { type?: unknown };
  return (
    v.type === 'ui.sidebar_request' ||
    v.type === 'ui.sidebar_response' ||
    v.type === 'ui.navigate_pane' ||
    v.type === 'ui.request_pane_layout' ||
    v.type === 'ui.pane_layout_response' ||
    v.type === 'ui.register_client' ||
    v.type === 'ui.pane_layout_changed'
  );
}
