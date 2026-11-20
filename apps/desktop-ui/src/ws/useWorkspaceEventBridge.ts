/**
 * Workspace event bridge.
 *
 * Subscribes to the `workspace` WebSocket channel and translates inbound wire
 * `WorkspaceEvent`s into in-process `emitLibraryEvent(...)` calls. Existing
 * in-tab subscribers then update cached snapshots or refetch pane-owned data.
 *
 * See: packages/shared/types/workspace-events.ts
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  WORKSPACE_EVENT_CHANNEL,
  isWorkspaceEvent,
  type WorkspaceEvent,
  type WorkspaceEventOfType,
} from '@snaglet/shared/types/workspace-events';
import type { ThreadRunAlert, WsMessage } from '@snaglet/shared/types';
import { emitLibraryEvent, type LibraryNodeKind } from '@desktop/utils/workspaceEvents';
import {
  markThreadRunFinished,
  markThreadRunStarted,
  seedRunningThreads,
  setThreadRunParent,
} from '@desktop/utils/threadRunState';
import {
  markAgentWorkFinished,
  markAgentWorkStarted,
  seedAgentWork,
} from '@desktop/utils/agentWorkState';
import { invalidateHookRuns, markHookRun, seedHookRuns } from '@desktop/utils/hookRunState';
import {
  addNotification,
  markNotificationRead,
  removeNotification,
  seedNotifications,
} from '@desktop/utils/notificationState';
import {
  claimRunAlert,
  isWatchingThread,
  runAlertClaimStore,
} from '@desktop/features/thread-notifications/runAlerts';
import { playReminderSound } from '@desktop/features/reminders/reminderSounds';
import { closeOsNotification, showOsNotification } from '@desktop/utils/osNotification';
import { emitTableEvent } from '@desktop/features/database/tableEvents';
import { invalidateAgentRoster } from '@desktop/features/rich-markdown/editor/agentMentionCache';
import { emitAgentEvent } from '@desktop/utils/agentEvents';
import { emitModelsChanged } from '@desktop/utils/modelEvents';
import { agentsApi, hookRunsApi, notificationsApi, threadsApi } from '@desktop/utils/api';
import { useWs } from './useWs';

export interface WorkspaceEventBridgeHandlers {
  /**
   * Fired for all tree-shape mutations:
   *   - `workspace.created` / `workspace.updated` / `workspace.deleted`
   *   - `workspace.archived` / `workspace.restored`
   *   - `doc.saved` (body changes — grouped with tree for v1 because the
   *     downstream consumer treats it as another reason to refresh)
   *   - `thread.created` / `thread.updated` / `thread.deleted`
   *
   * v1 contract: receiver should refetch the affected subtree. Fine-grained
   * dispatch (per-event patches into the in-process LibraryEvent bus) can
   * layer in later without changing this signature.
   */
  onTreeEvent?: (
    event: WorkspaceEventOfType<
      | 'workspace.created'
      | 'workspace.updated'
      | 'workspace.deleted'
      | 'workspace.archived'
      | 'workspace.restored'
      | 'doc.saved'
      | 'thread.created'
      | 'thread.updated'
      | 'thread.deleted'
    >
  ) => void;
  /**
   * Agent records are not tree nodes. Treat the small `agent.updated`
   * payload as an invalidation signal and let the sidebar roster refetch its
   * canonical rows rather than attempting a partial role/name patch.
   */
  onAgentEvent?: (event: WorkspaceEventOfType<'agent.updated'>) => void;
  /**
   * The thread the active pane is showing, if any. Used by `thread.run_alert`
   * to stay silent about the thread the user is already watching
   * (`isWatchingThread`).
   */
  activeThreadId?: string | null;
  /**
   * Open a thread in the active pane — what a click on a run-alert banner
   * does, mirroring a tray notification's click.
   */
  onOpenThread?: (threadId: string) => void;
  /**
   * Optional escape hatch — fires for every WorkspaceEvent regardless of type.
   * Use sparingly; prefer the typed handlers above.
   */
  onAny?: (event: WorkspaceEvent) => void;
}

/**
 * Raise a per-thread run-ended alert in this window: a forced OS banner whose
 * click opens the thread, plus the chosen sound. Skipped when the user is
 * already watching the thread in this focused window, or another window
 * claimed the alert. Exactly one sound per alert: the in-app sound plays only
 * when `showOsNotification` reports, after the attempt, that the banner made
 * none.
 */
async function handleRunAlert(
  alert: ThreadRunAlert,
  handlers: WorkspaceEventBridgeHandlers
): Promise<void> {
  const focused = typeof document === 'undefined' ? false : document.hasFocus();
  if (
    isWatchingThread({
      threadId: alert.threadId,
      activeThreadId: handlers.activeThreadId ?? null,
      windowFocused: focused,
    })
  ) {
    return;
  }
  if (!claimRunAlert(alert.runId, runAlertClaimStore())) return;

  const openThread = handlers.onOpenThread;
  const outcome = await showOsNotification({
    id: alert.notificationId ?? `run-alert-${alert.runId}`,
    type: alert.status === 'failed' ? 'run_failed' : 'run_completed',
    title: alert.title,
    body: alert.body,
    force: true,
    sound: alert.sound,
    ...(openThread ? { onClick: () => openThread(alert.threadId) } : {}),
  });
  if (!outcome.sounded) playReminderSound(alert.sound);
}

/**
 * Subscribe to the workspace WS channel and bridge events into the existing
 * in-process buses (LibraryEvent) plus consumer-supplied handlers for state
 * stores that don't live in LibraryEvent (tasks).
 *
 * Mount this once at the app root (inside WorkspaceProvider / TaskDataProvider).
 * Mounting twice is harmless but duplicates dispatch.
 */
export function useWorkspaceEventBridge(handlers: WorkspaceEventBridgeHandlers = {}): void {
  const { subscribe, unsubscribe, addMessageListener, connectionState } = useWs();
  // Stable handlers ref so we don't re-attach the message effect on every render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const parentThreadByRun = useRef(new Map<string, string | null>());

  const projectRunToParentThread = useCallback(async (threadId: string): Promise<void> => {
    if (parentThreadByRun.current.has(threadId)) return;
    try {
      const thread = await threadsApi.get(threadId);
      const parentThreadId = thread.parentThreadId ?? null;
      parentThreadByRun.current.set(threadId, parentThreadId);
      setThreadRunParent(threadId, parentThreadId);
    } catch (err: unknown) {
      // A deleted helper may finish after its row is deleted. Its direct run
      // state still settles normally; it simply has no parent to project to.
      console.error('[workspace-events] failed to resolve thread run parent', err);
    }
  }, []);

  // Subscribe to the workspace channel on mount + after reconnect.
  useEffect(() => {
    subscribe(WORKSPACE_EVENT_CHANNEL);
    return () => unsubscribe(WORKSPACE_EVENT_CHANNEL);
  }, [subscribe, unsubscribe]);

  useEffect(() => {
    if (connectionState !== 'open') return;
    subscribe(WORKSPACE_EVENT_CHANNEL);
    // Events missed while disconnected are not replayed. Refresh hydrated
    // trees/panes on each connection, including the initial subscription gap.
    emitLibraryEvent({ type: 'tree-invalidated', ids: [] });
    emitTableEvent({ type: 'tables.invalidated' });
    invalidateAgentRoster();
    emitAgentEvent({ type: 'agents.invalidated' });
    emitModelsChanged();
    // Balanced release — the provider's channel registry is holder-counted.
    return () => unsubscribe(WORKSPACE_EVENT_CHANNEL);
  }, [connectionState, subscribe, unsubscribe]);

  // Seed thread run-state on every (re)connect: `thread.run_*` events only
  // cover transitions after the subscription, so runs already in flight
  // (or state drift across a disconnect) come from the snapshot endpoint.
  useEffect(() => {
    if (connectionState !== 'open') return;
    let canceled = false;
    threadsApi
      .activeRuns()
      .then(async (threadIds) => {
        await Promise.all(threadIds.map((threadId) => projectRunToParentThread(threadId)));
        if (!canceled) seedRunningThreads(threadIds);
      })
      .catch((err: unknown) => {
        // Non-fatal: indicators stay event-driven until the next reconnect.
        console.error('[workspace-events] failed to seed active thread runs', err);
      });
    // Same contract for the agent-work surface: `agent.work_*` events only
    // cover transitions after the subscription, so work already in flight
    // comes from the snapshot endpoint.
    agentsApi
      .activeWork()
      .then((items) => {
        if (!canceled) seedAgentWork(items);
      })
      .catch((err: unknown) => {
        console.error('[workspace-events] failed to seed active agent work', err);
      });
    hookRunsApi
      .recent(100)
      .then((runs) => {
        if (!canceled) seedHookRuns(runs);
      })
      .catch((err: unknown) => {
        console.error('[workspace-events] failed to seed hook run history', err);
      });
    notificationsApi
      .list(50)
      .then((notifications) => {
        if (!canceled) seedNotifications(notifications);
      })
      .catch((err: unknown) => {
        console.error('[workspace-events] failed to seed notifications', err);
      });
    return () => {
      canceled = true;
    };
  }, [connectionState]);

  const handleMessage = useCallback((message: WsMessage) => {
    if (message.channel !== WORKSPACE_EVENT_CHANNEL) return;
    const evt = message.payload;
    if (!isWorkspaceEvent(evt)) {
      return;
    }

    // Fire onAny first so diagnostics see everything.
    handlersRef.current.onAny?.(evt);

    // Route by surface.
    switch (evt.type) {
      case 'workspace.created':
        emitLibraryEvent({ type: 'tree-invalidated', ids: [evt.node.id] });
        handlersRef.current.onTreeEvent?.(evt);
        break;
      case 'workspace.updated':
        if (evt.patch.title !== undefined) {
          emitLibraryEvent({
            type: 'renamed',
            kind: evt.patch.kind as LibraryNodeKind,
            id: evt.patch.id,
            name: evt.patch.title,
          });
        }
        if (
          evt.patch.parentId !== undefined ||
          evt.patch.sortKey !== undefined ||
          // A container category edit from another client — refetch so
          // tree-visible affordances (e.g. the project-home icon) repaint.
          // Same existing invalidation event; no new type.
          evt.patch.category !== undefined
        ) {
          emitLibraryEvent({ type: 'tree-invalidated', ids: [evt.patch.id] });
        }
        if (
          evt.patch.kind === 'image' &&
          (evt.patch.description !== undefined || evt.patch.tags !== undefined)
        ) {
          emitLibraryEvent({
            type: 'image-metadata-saved',
            id: evt.patch.id,
            ...(evt.patch.description !== undefined ? { description: evt.patch.description } : {}),
            ...(evt.patch.tags !== undefined ? { tags: evt.patch.tags } : {}),
            updatedAt: evt.patch.updatedAt,
          });
        }
        handlersRef.current.onTreeEvent?.(evt);
        break;
      case 'workspace.deleted':
        emitLibraryEvent({ type: 'deleted', kind: evt.kind as LibraryNodeKind, id: evt.id });
        emitLibraryEvent({ type: 'tree-invalidated', ids: [evt.id] });
        handlersRef.current.onTreeEvent?.(evt);
        break;
      case 'workspace.archived':
        emitLibraryEvent({ type: 'archive-changed', ids: [evt.id] });
        handlersRef.current.onTreeEvent?.(evt);
        break;
      case 'workspace.restored':
        // A restored node isn't in any local cache, so only a reload brings
        // it (and a pane showing it as unavailable) back, as a local restore does.
        emitLibraryEvent({ type: 'archive-changed', ids: [evt.id], reload: true });
        handlersRef.current.onTreeEvent?.(evt);
        break;
      case 'doc.saved':
        emitLibraryEvent({
          type: 'doc-saved',
          id: evt.id,
          content: evt.body,
          updatedAt: evt.updatedAt,
          ...(evt.lastEditedBy ? { lastEditedBy: evt.lastEditedBy } : {}),
        });
        handlersRef.current.onTreeEvent?.(evt);
        break;
      case 'file.embedding_coverage_changed':
        emitLibraryEvent({ type: 'file-embedding-coverage-changed' });
        break;
      case 'file.indexing_impact_changed':
        emitLibraryEvent({
          type: 'file-indexing-impact-changed',
          projectId: evt.projectId,
          eligibleFiles: evt.eligibleFiles,
          scannedEntries: evt.scannedEntries,
          capped: evt.capped,
        });
        break;
      case 'file.indexing_status_changed':
        emitLibraryEvent({
          type: 'file-indexing-status-changed',
          projectId: evt.projectId,
          runtime: evt.runtime,
        });
        break;
      case 'thread.created':
        emitLibraryEvent({ type: 'tree-invalidated', ids: [evt.thread.id] });
        handlersRef.current.onTreeEvent?.(evt);
        break;
      case 'thread.updated':
        if (evt.patch.title !== undefined) {
          emitLibraryEvent({
            type: 'renamed',
            kind: 'thread',
            id: evt.patch.id,
            name: evt.patch.title,
          });
        }
        // A project-scope change also rides the tree surface as a
        // `workspace.updated` patch with the new `parentId` (every server
        // move path emits it, and a restore emits `workspace.restored`), and
        // that branch above already invalidates the tree. Invalidating here
        // too made one local thread drag refetch the tree three times.
        handlersRef.current.onTreeEvent?.(evt);
        break;
      case 'thread.deleted':
        emitLibraryEvent({ type: 'deleted', kind: 'thread', id: evt.id });
        emitLibraryEvent({ type: 'tree-invalidated', ids: [evt.id] });
        handlersRef.current.onTreeEvent?.(evt);
        break;
      case 'thread.run_started':
        markThreadRunStarted(evt.threadId);
        void projectRunToParentThread(evt.threadId);
        break;
      case 'thread.run_finished':
        markThreadRunFinished(evt.threadId);
        break;
      case 'agent.work_started':
        markAgentWorkStarted(evt.item);
        break;
      case 'agent.work_finished':
        markAgentWorkFinished(evt.id);
        break;
      case 'agent.updated':
        // `[Name](agent-id)` links chip from the shared agent roster, so it
        // follows every create, rename, archive, restore and delete.
        invalidateAgentRoster();
        // Open agent panes, pane titles and the roster follow it here.
        emitAgentEvent(evt);
        handlersRef.current.onAgentEvent?.(evt);
        break;
      case 'hook.run_started':
      case 'hook.run_finished':
        markHookRun(evt.run);
        break;
      case 'hook.enabled_changed':
        emitLibraryEvent({
          type: 'hook-enabled-changed',
          hookName: evt.hookName,
          enabled: evt.enabled,
        });
        break;
      case 'hook.registry_changed':
        emitLibraryEvent({ type: 'hook-registry-changed', hookNames: evt.hookNames });
        break;
      case 'hook.runs_changed':
        invalidateHookRuns(evt.hookNames);
        void hookRunsApi
          .recent(100)
          .then(seedHookRuns)
          .catch((err: unknown) => {
            console.error('[workspace-events] failed to refresh hook run history', err);
          });
        break;
      case 'notification.created': {
        addNotification(evt.notification);
        // A click opens the thread it came from (an agent's question, a
        // tool approval) — same as a run alert's banner.
        const { id, threadId } = evt.notification;
        const openThread = handlersRef.current.onOpenThread;
        void showOsNotification({
          id: evt.notification.id,
          type: evt.notification.type,
          title: evt.notification.title,
          body: evt.notification.body,
          ...(threadId && openThread
            ? {
                onClick: () => {
                  markNotificationRead(id);
                  void notificationsApi.markRead(id).catch((err: unknown) => {
                    console.error('[workspace-events] failed to mark notification read', err);
                  });
                  openThread(threadId);
                },
              }
            : {}),
        });
        break;
      }
      // A run ended in a thread whose settings asked to be told: banner +
      // the chosen sound. Deliberately NOT a tray entry — the
      // `notification.created` above already made the one entry for this run.
      case 'thread.run_alert':
        void handleRunAlert(evt.alert, handlersRef.current);
        break;
      case 'notification.dismissed':
        // A settled ask (answered, timed out, stopped) or a dismissal in
        // another window: drop it here too, OS banner included.
        removeNotification(evt.id);
        closeOsNotification(evt.id);
        break;

      // Database catalog: tables are not tree nodes. Every Database sidebar
      // and open table pane applies the entry by catalog id, so the
      // originating client's own echo (it already emitted locally on
      // success) is a no-op.
      case 'table.created':
        emitTableEvent({ type: 'table.created', table: evt.table });
        break;
      case 'table.updated':
        emitTableEvent({ type: 'table.updated', table: evt.table });
        break;
      case 'table.fields.changed':
        emitTableEvent({ type: 'table.fields.changed', tableId: evt.tableId });
        break;
      // One event per batch: `entryIds` names every entry written, or
      // `allEntries` stands in for a list too long to send.
      case 'table.entries.changed':
        emitTableEvent({
          type: 'table.entries.changed',
          tableId: evt.tableId,
          entryId: evt.entryId,
          ...(evt.entryIds ? { entryIds: evt.entryIds } : {}),
          ...(evt.allEntries ? { allEntries: evt.allEntries } : {}),
        });
        break;
      // A custom table was archived or deleted, or came back (restore, undo
      // or redo). Sidebars drop or re-add the row and open table panes show
      // it as archived, gone, or live again.
      case 'table.removed':
        emitTableEvent({ type: 'table.removed', tableId: evt.tableId, state: evt.state });
        break;
      case 'table.restored':
        emitTableEvent({ type: 'table.restored', table: evt.table });
        break;
      // An actor's table undo stack changed; the Undo/Redo controls
      // showing it refresh their next steps.
      case 'table.history.changed':
        emitTableEvent({ type: 'table.history.changed', stack: evt.stack });
        break;
      // A provider's model catalog changed; model pickers re-read their lists.
      case 'models.changed':
        emitModelsChanged();
        break;

      default: {
        // Exhaustiveness check.
        const _exhaustive: never = evt;
        void _exhaustive;
      }
    }
  }, []);

  useEffect(() => addMessageListener(handleMessage), [addMessageListener, handleMessage]);
}
