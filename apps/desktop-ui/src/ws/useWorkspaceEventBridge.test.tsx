import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceEvent, WorkspaceEventOfType } from '@snaglet/shared/types/workspace-events';
import type { WsMessage } from '@snaglet/shared/types';
import { onLibraryEvent, type LibraryEvent } from '@desktop/utils/workspaceEvents';
import {
  useWorkspaceEventBridge,
  type WorkspaceEventBridgeHandlers,
} from './useWorkspaceEventBridge';
import { subscribeTableEvents, type TableEvent } from '@desktop/features/database/tableEvents';
import { subscribeAgentEvents, type AgentEvent } from '@desktop/utils/agentEvents';
import { subscribeModelsChanged } from '@desktop/utils/modelEvents';
import { seedNotifications, useNotifications } from '@desktop/utils/notificationState';
import type { NotificationRecord, ThreadRunAlert } from '@snaglet/shared/types';
import { notificationsApi, threadsApi } from '@desktop/utils/api';
import { useThreadRunning } from '@desktop/utils/threadRunState';

const ws = vi.hoisted(() => {
  const listeners = new Set<(message: WsMessage) => void>();
  return {
    listeners,
    connectionState: 'closed',
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    addMessageListener: vi.fn((listener: (message: WsMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
});

vi.mock('./useWs', () => ({
  useWs: () => ({
    connectionState: ws.connectionState,
    subscribe: ws.subscribe,
    unsubscribe: ws.unsubscribe,
    addMessageListener: ws.addMessageListener,
  }),
}));

const os = vi.hoisted(() => ({
  showOsNotification: vi.fn(
    async (_input: unknown): Promise<{ shown: boolean; sounded: boolean }> => ({
      shown: true,
      sounded: true,
    })
  ),
  closeOsNotification: vi.fn(),
}));

vi.mock('@desktop/utils/osNotification', () => os);

const sounds = vi.hoisted(() => ({ playReminderSound: vi.fn() }));

vi.mock('@desktop/features/reminders/reminderSounds', () => sounds);

const roster = vi.hoisted(() => ({ invalidate: vi.fn() }));

vi.mock('@desktop/features/rich-markdown/editor/agentMentionCache', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@desktop/features/rich-markdown/editor/agentMentionCache')
  >()),
  invalidateAgentRoster: roster.invalidate,
}));

vi.mock('@desktop/utils/api', () => ({
  agentsApi: { activeWork: vi.fn().mockResolvedValue([]) },
  hookRunsApi: { recent: vi.fn().mockResolvedValue([]) },
  notificationsApi: {
    list: vi.fn().mockResolvedValue([]),
    markRead: vi.fn().mockResolvedValue(null),
  },
  threadsApi: { activeRuns: vi.fn().mockResolvedValue([]), get: vi.fn() },
}));

const meta = {
  ts: '2026-08-04T00:00:00.000Z',
  actor: { actorId: 'user-1', actorKind: 'user' as const },
  originClientId: 'origin-window',
};

function dispatchWorkspace(event: WorkspaceEvent): void {
  const message = { type: 'event', channel: 'workspace', payload: event } as WsMessage;
  act(() => {
    for (const listener of [...ws.listeners]) listener(message);
  });
}

/** Let the async run-alert handler (it awaits the banner) settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function BridgeHarness(handlers: WorkspaceEventBridgeHandlers) {
  useWorkspaceEventBridge(handlers);
  return null;
}

function RunningProbe({ threadId }: { threadId: string }) {
  return <>{useThreadRunning(threadId) ? 'running' : 'idle'}</>;
}

describe('useWorkspaceEventBridge sidebar invalidations', () => {
  beforeEach(() => {
    ws.connectionState = 'closed';
    ws.listeners.clear();
    ws.subscribe.mockClear();
    ws.unsubscribe.mockClear();
    ws.addMessageListener.mockClear();
    vi.mocked(threadsApi.activeRuns).mockResolvedValue([]);
    vi.mocked(threadsApi.get).mockReset();
  });

  afterEach(() => {
    ws.listeners.clear();
  });

  it('projects a hidden helper run and reconnect seed to its visible parent', async () => {
    vi.mocked(threadsApi.get).mockResolvedValue({ parentThreadId: 'thread-parent' } as never);
    vi.mocked(threadsApi.activeRuns).mockResolvedValue(['thread-helper']);
    ws.connectionState = 'open';
    const view = render(
      <>
        <BridgeHarness />
        <RunningProbe threadId="thread-parent" />
      </>
    );

    await act(async () => {});
    expect(view.getByText('running')).toBeTruthy();
    expect(threadsApi.get).toHaveBeenCalledWith('thread-helper');

    dispatchWorkspace({ type: 'thread.run_finished', threadId: 'thread-helper', ...meta });
    dispatchWorkspace({ type: 'thread.run_started', threadId: 'thread-helper', ...meta });
    await act(async () => {});
    expect(view.getByText('running')).toBeTruthy();
  });

  it('invalidates missed tree changes once per connection and stops after unmount', async () => {
    const events: LibraryEvent[] = [];
    const tables: TableEvent[] = [];
    const stopTables = subscribeTableEvents((event) => tables.push(event));
    const stop = onLibraryEvent((event) => events.push(event));
    const view = render(<BridgeHarness />);
    expect(events).toEqual([]);
    ws.connectionState = 'open';
    await act(async () => view.rerender(<BridgeHarness />));
    expect(events).toEqual([{ type: 'tree-invalidated', ids: [] }]);
    expect(tables).toEqual([{ type: 'tables.invalidated' }]);
    view.rerender(<BridgeHarness />);
    expect(events).toHaveLength(1);
    expect(tables).toHaveLength(1);
    ws.connectionState = 'closed';
    view.rerender(<BridgeHarness />);
    ws.connectionState = 'open';
    await act(async () => view.rerender(<BridgeHarness />));
    expect(events).toHaveLength(2);
    expect(tables).toEqual([{ type: 'tables.invalidated' }, { type: 'tables.invalidated' }]);
    view.unmount();
    expect(ws.listeners.size).toBe(0);
    stop();
    stopTables();
  });

  it('reloads on a restore from elsewhere, but not on an archive', () => {
    const libraryEvents: LibraryEvent[] = [];
    const stop = onLibraryEvent((event) => libraryEvents.push(event));
    render(<BridgeHarness />);

    dispatchWorkspace({
      type: 'workspace.archived',
      id: 'doc-1111111111111-aaaaaaaaa',
      kind: 'doc',
      archivedAt: '2026-08-04T00:00:01.000Z',
      ...meta,
    });
    dispatchWorkspace({
      type: 'workspace.restored',
      id: 'doc-1111111111111-aaaaaaaaa',
      kind: 'doc',
      node: {
        id: 'doc-1111111111111-aaaaaaaaa',
        kind: 'doc',
        title: 'Test doc',
        parentId: null,
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:02.000Z',
      },
      ...meta,
    });

    expect(libraryEvents.filter((event) => event.type === 'archive-changed')).toEqual([
      { type: 'archive-changed', ids: ['doc-1111111111111-aaaaaaaaa'] },
      { type: 'archive-changed', ids: ['doc-1111111111111-aaaaaaaaa'], reload: true },
    ]);
    stop();
  });

  it('invalidates the current tree for a changed container category', () => {
    const changed = { kind: 'container' as const, category: 'project' as const };
    const onTreeEvent = vi.fn();
    const libraryEvents: LibraryEvent[] = [];
    const stop = onLibraryEvent((event) => libraryEvents.push(event));
    render(<BridgeHarness onTreeEvent={onTreeEvent} />);

    dispatchWorkspace({
      type: 'workspace.updated',
      patch: {
        id: 'node-1',
        ...changed,
        updatedAt: '2026-08-04T00:00:01.000Z',
      },
      ...meta,
    });

    expect(onTreeEvent).toHaveBeenCalledTimes(1);
    expect(libraryEvents).toContainEqual({ type: 'tree-invalidated', ids: ['node-1'] });
    stop();
  });

  it('leaves tree invalidation of a thread move to the workspace surface, and renames in place', () => {
    const libraryEvents: LibraryEvent[] = [];
    const stop = onLibraryEvent((event) => libraryEvents.push(event));
    render(<BridgeHarness />);

    dispatchWorkspace({
      type: 'thread.updated',
      patch: {
        id: 'thread-1111111111111-aaaaaaaaa',
        title: 'Renamed chat',
        updatedAt: '2026-08-04T00:00:01.000Z',
      },
      ...meta,
    });
    expect(libraryEvents).toEqual([
      {
        type: 'renamed',
        kind: 'thread',
        id: 'thread-1111111111111-aaaaaaaaa',
        name: 'Renamed chat',
      },
    ]);

    // The server echoes one move as both events; only the tree surface's
    // patch refetches, so the originating drag is not refetched twice over.
    dispatchWorkspace({
      type: 'thread.updated',
      patch: {
        id: 'thread-1111111111111-aaaaaaaaa',
        projectId: null,
        updatedAt: '2026-08-04T00:00:02.000Z',
      },
      ...meta,
    });
    expect(libraryEvents).toHaveLength(1);
    dispatchWorkspace({
      type: 'workspace.updated',
      patch: {
        id: 'thread-1111111111111-aaaaaaaaa',
        kind: 'thread',
        parentId: null,
        updatedAt: '2026-08-04T00:00:02.000Z',
      },
      ...meta,
    });
    expect(libraryEvents.slice(1)).toEqual([
      { type: 'tree-invalidated', ids: ['thread-1111111111111-aaaaaaaaa'] },
    ]);
    stop();
  });

  it('delivers agent.updated to same-window and second-window invalidation handlers', () => {
    const firstWindow = vi.fn();
    const secondWindow = vi.fn();
    const first = render(<BridgeHarness onAgentEvent={firstWindow} />);
    const second = render(<BridgeHarness onAgentEvent={secondWindow} />);

    const event: WorkspaceEventOfType<'agent.updated'> = {
      type: 'agent.updated',
      agentId: 'agent-1',
      changed: ['role'],
      ...meta,
    };
    dispatchWorkspace(event);

    expect(firstWindow).toHaveBeenCalledWith(event);
    expect(secondWindow).toHaveBeenCalledWith(event);

    first.unmount();
    second.unmount();
  });

  it('refetches the shared agent roster on agent.updated and after each reconnect', async () => {
    roster.invalidate.mockClear();
    const view = render(<BridgeHarness />);

    dispatchWorkspace({
      type: 'agent.updated',
      agentId: 'test-agent-a',
      changed: ['archived'],
      ...meta,
    });
    expect(roster.invalidate).toHaveBeenCalledTimes(1);

    dispatchWorkspace({
      type: 'workspace.updated',
      patch: { id: 'doc-1', kind: 'doc', title: 'Renamed doc', updatedAt: meta.ts },
      ...meta,
    });
    expect(roster.invalidate).toHaveBeenCalledTimes(1);

    // Agent events missed while disconnected are not replayed.
    ws.connectionState = 'open';
    await act(async () => view.rerender(<BridgeHarness />));
    expect(roster.invalidate).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('puts agent.updated on the agent bus, actor and revision included, for open agent panes', () => {
    const agentEvents: AgentEvent[] = [];
    const stop = subscribeAgentEvents((event) => agentEvents.push(event));
    const view = render(<BridgeHarness />);

    const event: WorkspaceEventOfType<'agent.updated'> = {
      type: 'agent.updated',
      agentId: 'agent-1',
      changed: ['systemPrompt'],
      updatedAt: '2026-11-16T10:00:00.000001+00:00',
      ...meta,
      actor: { actorId: 'agent-2', actorKind: 'agent', actorName: 'Patty' },
    };
    dispatchWorkspace(event);

    expect(agentEvents).toEqual([event]);
    stop();
    view.unmount();
  });

  it('tells agent panes to resync after each reconnect, since missed events are not replayed', async () => {
    const agentEvents: AgentEvent[] = [];
    const stop = subscribeAgentEvents((event) => agentEvents.push(event));
    const view = render(<BridgeHarness />);
    expect(agentEvents).toEqual([]);

    ws.connectionState = 'open';
    await act(async () => view.rerender(<BridgeHarness />));
    expect(agentEvents).toEqual([{ type: 'agents.invalidated' }]);

    ws.connectionState = 'closed';
    await act(async () => view.rerender(<BridgeHarness />));
    ws.connectionState = 'open';
    await act(async () => view.rerender(<BridgeHarness />));
    expect(agentEvents).toEqual([{ type: 'agents.invalidated' }, { type: 'agents.invalidated' }]);
    stop();
    view.unmount();
  });

  it('tells model pickers to re-read on models.changed and after each reconnect', async () => {
    let signals = 0;
    const stop = subscribeModelsChanged(() => {
      signals += 1;
    });
    const view = render(<BridgeHarness />);

    dispatchWorkspace({ type: 'models.changed', providerId: 'anthropic', ...meta });
    expect(signals).toBe(1);

    ws.connectionState = 'open';
    await act(async () => view.rerender(<BridgeHarness />));
    expect(signals).toBe(2);
    stop();
    view.unmount();
  });

  it('does not refresh agents for unrelated workspace events', () => {
    const onAgentEvent = vi.fn();
    render(<BridgeHarness onAgentEvent={onAgentEvent} />);

    dispatchWorkspace({
      type: 'workspace.updated',
      patch: {
        id: 'doc-1',
        kind: 'doc',
        title: 'Renamed doc',
        updatedAt: '2026-08-04T00:00:01.000Z',
      },
      ...meta,
    });

    expect(onAgentEvent).not.toHaveBeenCalled();
  });

  it('removes only the unmounted window listener and unsubscribes cleanly', () => {
    const firstWindow = vi.fn();
    const secondWindow = vi.fn();
    const first = render(<BridgeHarness onAgentEvent={firstWindow} />);
    const second = render(<BridgeHarness onAgentEvent={secondWindow} />);
    expect(ws.listeners.size).toBe(2);

    first.unmount();
    expect(ws.listeners.size).toBe(1);
    dispatchWorkspace({
      type: 'agent.updated',
      agentId: 'agent-1',
      changed: ['role'],
      ...meta,
    });

    expect(firstWindow).not.toHaveBeenCalled();
    expect(secondWindow).toHaveBeenCalledTimes(1);

    second.unmount();
    expect(ws.listeners.size).toBe(0);
    expect(ws.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('relays hook.enabled_changed to the hook lists and builder panes', () => {
    const libraryEvents: LibraryEvent[] = [];
    const stopLibrary = onLibraryEvent((event) => libraryEvents.push(event));
    const onTreeEvent = vi.fn();
    render(<BridgeHarness onTreeEvent={onTreeEvent} />);

    dispatchWorkspace({
      type: 'hook.enabled_changed',
      hookName: 'test-hook',
      enabled: false,
      ...meta,
    });

    expect(libraryEvents).toEqual([
      { type: 'hook-enabled-changed', hookName: 'test-hook', enabled: false },
    ]);
    expect(onTreeEvent).not.toHaveBeenCalled();
    stopLibrary();
  });

  it('relays hook.registry_changed to the script lists', () => {
    const libraryEvents: LibraryEvent[] = [];
    const stopLibrary = onLibraryEvent((event) => libraryEvents.push(event));
    const onTreeEvent = vi.fn();
    render(<BridgeHarness onTreeEvent={onTreeEvent} />);

    dispatchWorkspace({ type: 'hook.registry_changed', hookNames: ['test-hook'], ...meta });

    expect(libraryEvents).toEqual([{ type: 'hook-registry-changed', hookNames: ['test-hook'] }]);
    expect(onTreeEvent).not.toHaveBeenCalled();
    stopLibrary();
  });

  it('relays doc.saved with its editor, and without one when the save names none', () => {
    const libraryEvents: LibraryEvent[] = [];
    const stopLibrary = onLibraryEvent((event) => libraryEvents.push(event));
    const onTreeEvent = vi.fn();
    render(<BridgeHarness onTreeEvent={onTreeEvent} />);
    const doc = 'doc-1111111111111-aaaaaaaaa';

    dispatchWorkspace({
      type: 'doc.saved',
      id: doc,
      body: 'Edited body',
      updatedAt: '2026-08-04T00:00:01.000Z',
      lastEditedBy: 'member-test-a',
      ...meta,
    });
    // An unattributed save sends no editor.
    dispatchWorkspace({
      type: 'doc.saved',
      id: doc,
      body: 'System body',
      updatedAt: '2026-08-04T00:00:02.000Z',
      ...meta,
    });

    expect(libraryEvents).toEqual([
      {
        type: 'doc-saved',
        id: doc,
        content: 'Edited body',
        updatedAt: '2026-08-04T00:00:01.000Z',
        lastEditedBy: 'member-test-a',
      },
      { type: 'doc-saved', id: doc, content: 'System body', updatedAt: '2026-08-04T00:00:02.000Z' },
    ]);
    expect(onTreeEvent).toHaveBeenCalledTimes(2);
    stopLibrary();
  });

  it('forwards table.created to the Database table bus only', () => {
    const table = {
      id: 'table-1111111111111-aaaaaaaaa',
      name: 'Reading list',
      origin: 'custom' as const,
      projectId: null,
      sortOrder: 0,
      createdAt: '2026-08-04T00:00:00.000Z',
    };
    const seen: TableEvent[] = [];
    const libraryEvents: LibraryEvent[] = [];
    const stop = subscribeTableEvents((event) => seen.push(event));
    const stopLibrary = onLibraryEvent((event) => libraryEvents.push(event));
    const onTreeEvent = vi.fn();
    render(<BridgeHarness onTreeEvent={onTreeEvent} />);

    dispatchWorkspace({ type: 'table.created', table, ...meta });

    expect(seen).toEqual([{ type: 'table.created', table }]);
    // Catalog tables are not workspace nodes: no tree refresh.
    expect(libraryEvents).toEqual([]);
    expect(onTreeEvent).not.toHaveBeenCalled();
    stop();
    stopLibrary();
  });

  it('forwards field changes to the Database bus without invalidating the workspace tree', () => {
    const seen: TableEvent[] = [];
    const libraryEvents: LibraryEvent[] = [];
    const stop = subscribeTableEvents((event) => seen.push(event));
    const stopLibrary = onLibraryEvent((event) => libraryEvents.push(event));
    const onTreeEvent = vi.fn();
    render(<BridgeHarness onTreeEvent={onTreeEvent} />);
    const tableId = 'table-1111111111111-aaaaaaaaa';

    dispatchWorkspace({ type: 'table.fields.changed', tableId, ...meta });

    expect(seen).toEqual([{ type: 'table.fields.changed', tableId }]);
    expect(libraryEvents).toEqual([]);
    expect(onTreeEvent).not.toHaveBeenCalled();
    stop();
    stopLibrary();
  });

  it('forwards entry changes to the Database bus without invalidating the workspace tree', () => {
    const seen: TableEvent[] = [];
    const libraryEvents: LibraryEvent[] = [];
    const stop = subscribeTableEvents((event) => seen.push(event));
    const stopLibrary = onLibraryEvent((event) => libraryEvents.push(event));
    const onTreeEvent = vi.fn();
    render(<BridgeHarness onTreeEvent={onTreeEvent} />);
    const tableId = 'table-1111111111111-aaaaaaaaa';

    dispatchWorkspace({
      type: 'table.entries.changed',
      tableId,
      entryId: '00000000-0000-4000-8000-000000000001',
      ...meta,
    });

    expect(seen).toEqual([
      { type: 'table.entries.changed', tableId, entryId: '00000000-0000-4000-8000-000000000001' },
    ]);
    expect(libraryEvents).toEqual([]);
    expect(onTreeEvent).not.toHaveBeenCalled();
    stop();
    stopLibrary();
  });

  it("relays a batch's entryIds, and allEntries, to the Database bus", () => {
    const seen: TableEvent[] = [];
    const stop = subscribeTableEvents((event) => seen.push(event));
    render(<BridgeHarness />);
    const tableId = 'table-1111111111111-aaaaaaaaa';
    const a = '00000000-0000-4000-8000-000000000001';
    const b = '00000000-0000-4000-8000-000000000002';

    dispatchWorkspace({
      type: 'table.entries.changed',
      tableId,
      entryId: a,
      entryIds: [a, b],
      ...meta,
    });
    dispatchWorkspace({
      type: 'table.entries.changed',
      tableId,
      entryId: a,
      allEntries: true,
      ...meta,
    });

    expect(seen).toEqual([
      { type: 'table.entries.changed', tableId, entryId: a, entryIds: [a, b] },
      { type: 'table.entries.changed', tableId, entryId: a, allEntries: true },
    ]);
    stop();
  });

  it('forwards table.updated renames to the Database table bus only', () => {
    const table = {
      id: 'table-1111111111111-aaaaaaaaa',
      name: 'Reading notes',
      origin: 'custom' as const,
      projectId: null,
      sortOrder: 0,
      createdAt: '2026-08-04T00:00:00.000Z',
    };
    const seen: TableEvent[] = [];
    const libraryEvents: LibraryEvent[] = [];
    const stop = subscribeTableEvents((event) => seen.push(event));
    const stopLibrary = onLibraryEvent((event) => libraryEvents.push(event));
    const onTreeEvent = vi.fn();
    render(<BridgeHarness onTreeEvent={onTreeEvent} />);

    dispatchWorkspace({ type: 'table.updated', table, ...meta });

    expect(seen).toEqual([{ type: 'table.updated', table }]);
    expect(libraryEvents).toEqual([]);
    expect(onTreeEvent).not.toHaveBeenCalled();
    stop();
    stopLibrary();
  });

  it('relays table archive, delete, restore and undo history changes to the Database bus', () => {
    const table = {
      id: 'table-1111111111111-aaaaaaaaa',
      name: 'reading_list',
      origin: 'custom' as const,
      projectId: null,
      sortOrder: 0,
      createdAt: '2026-08-04T00:00:00.000Z',
    };
    const seen: TableEvent[] = [];
    const libraryEvents: LibraryEvent[] = [];
    const stop = subscribeTableEvents((event) => seen.push(event));
    const stopLibrary = onLibraryEvent((event) => libraryEvents.push(event));
    const onTreeEvent = vi.fn();
    render(<BridgeHarness onTreeEvent={onTreeEvent} />);

    dispatchWorkspace({ type: 'table.removed', tableId: table.id, state: 'archived', ...meta });
    dispatchWorkspace({ type: 'table.restored', table, ...meta });
    dispatchWorkspace({ type: 'table.removed', tableId: table.id, state: 'deleted', ...meta });
    dispatchWorkspace({
      type: 'table.history.changed',
      stack: { kind: 'user', id: 'user-1' },
      ...meta,
    });

    expect(seen).toEqual([
      { type: 'table.removed', tableId: table.id, state: 'archived' },
      { type: 'table.restored', table },
      { type: 'table.removed', tableId: table.id, state: 'deleted' },
      { type: 'table.history.changed', stack: { kind: 'user', id: 'user-1' } },
    ]);
    expect(libraryEvents).toEqual([]);
    expect(onTreeEvent).not.toHaveBeenCalled();
    stop();
    stopLibrary();
  });
});

describe('useWorkspaceEventBridge notifications', () => {
  function approval(id: string): NotificationRecord {
    return {
      id,
      type: 'tool_approval',
      title: 'Test Agent A needs your approval',
      body: 'shell: { "command": "git status" }',
      threadId: 'thread-1111111111111-aaaaaaaaa',
      agentId: 'test-agent-a',
      runId: null,
      read: false,
      dismissed: false,
      createdAt: '2026-08-04T00:00:00.000Z',
    };
  }

  let shown: NotificationRecord[] = [];
  function TrayProbe() {
    shown = useNotifications();
    return null;
  }

  beforeEach(() => {
    ws.connectionState = 'closed';
    ws.listeners.clear();
    os.showOsNotification.mockClear();
    os.closeOsNotification.mockClear();
    vi.mocked(notificationsApi.markRead).mockReset().mockResolvedValue(null);
    act(() => seedNotifications([]));
  });

  afterEach(() => {
    ws.listeners.clear();
  });

  it('shows a new notification with an OS banner keyed by its id', () => {
    render(
      <>
        <BridgeHarness />
        <TrayProbe />
      </>
    );

    dispatchWorkspace({
      type: 'notification.created',
      notification: approval('notif-ask-a'),
      ...meta,
    });

    expect(shown.map((n) => n.id)).toEqual(['notif-ask-a']);
    expect(os.showOsNotification).toHaveBeenCalledWith({
      id: 'notif-ask-a',
      type: 'tool_approval',
      title: 'Test Agent A needs your approval',
      body: 'shell: { "command": "git status" }',
    });
  });

  it('marks only the clicked banner read locally and on the server while opening its thread', () => {
    const onOpenThread = vi.fn();
    render(
      <>
        <BridgeHarness onOpenThread={onOpenThread} />
        <TrayProbe />
      </>
    );

    for (const id of ['notif-ask-click', 'notif-other']) {
      dispatchWorkspace({ type: 'notification.created', notification: approval(id), ...meta });
    }
    expect(shown.every((notification) => !notification.read)).toBe(true);
    expect(notificationsApi.markRead).not.toHaveBeenCalled();
    const call = os.showOsNotification.mock.calls[0]?.[0] as { onClick: () => void };
    act(() => call.onClick());

    expect(shown.find((notification) => notification.id === 'notif-ask-click')?.read).toBe(true);
    expect(shown.find((notification) => notification.id === 'notif-other')?.read).toBe(false);
    expect(notificationsApi.markRead).toHaveBeenCalledExactlyOnceWith('notif-ask-click');
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith('thread-1111111111111-aaaaaaaaa');
  });

  it('keeps optimistic read state and navigation if marking the banner read fails', async () => {
    const error = new Error('offline');
    vi.mocked(notificationsApi.markRead).mockRejectedValueOnce(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onOpenThread = vi.fn();
    try {
      render(
        <>
          <BridgeHarness onOpenThread={onOpenThread} />
          <TrayProbe />
        </>
      );
      dispatchWorkspace({
        type: 'notification.created',
        notification: approval('notif-failed-read'),
        ...meta,
      });
      const call = os.showOsNotification.mock.calls[0]?.[0] as { onClick: () => void };
      act(() => call.onClick());
      expect(shown[0]?.read).toBe(true);
      expect(onOpenThread).toHaveBeenCalledWith('thread-1111111111111-aaaaaaaaa');
      await flush();
      expect(log).toHaveBeenCalledWith(
        '[workspace-events] failed to mark notification read',
        error
      );
    } finally {
      log.mockRestore();
    }
  });

  it('gives a notification without a thread no click action', () => {
    render(<BridgeHarness onOpenThread={vi.fn()} />);

    dispatchWorkspace({
      type: 'notification.created',
      notification: { ...approval('notif-no-thread'), threadId: null },
      ...meta,
    });

    expect(os.showOsNotification.mock.calls[0]?.[0]).not.toHaveProperty('onClick');
  });

  it('drops a dismissed notification from the tray and closes its OS banner', () => {
    render(
      <>
        <BridgeHarness />
        <TrayProbe />
      </>
    );
    dispatchWorkspace({
      type: 'notification.created',
      notification: approval('notif-ask-a'),
      ...meta,
    });
    dispatchWorkspace({
      type: 'notification.created',
      notification: approval('notif-ask-b'),
      ...meta,
    });

    dispatchWorkspace({ type: 'notification.dismissed', id: 'notif-ask-a', ...meta });

    expect(shown.map((n) => n.id)).toEqual(['notif-ask-b']);
    expect(os.closeOsNotification).toHaveBeenCalledWith('notif-ask-a');
    expect(os.closeOsNotification).toHaveBeenCalledTimes(1);
  });
});

describe('useWorkspaceEventBridge thread run alerts', () => {
  const ALERT_THREAD = 'thread-1111111111111-aaaaaaaaa';

  function alertEvent(overrides: Partial<ThreadRunAlert> = {}): WorkspaceEvent {
    return {
      type: 'thread.run_alert',
      alert: {
        threadId: ALERT_THREAD,
        runId: `run-${Math.random().toString(36).slice(2)}`,
        status: 'completed',
        sound: 'chime',
        title: 'Test Agent A completed',
        body: 'Test Agent A finished in “Build”.',
        notificationId: 'notif-run-1',
        ...overrides,
      },
      ...meta,
    } as WorkspaceEvent;
  }

  let shown: NotificationRecord[] = [];
  function TrayProbe() {
    shown = useNotifications();
    return null;
  }

  beforeEach(() => {
    ws.connectionState = 'closed';
    ws.listeners.clear();
    os.showOsNotification.mockClear();
    os.showOsNotification.mockResolvedValue({ shown: true, sounded: true });
    sounds.playReminderSound.mockClear();
    window.localStorage.clear();
    act(() => seedNotifications([]));
    // Default: this window is focused but on no thread.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    ws.listeners.clear();
    vi.restoreAllMocks();
  });

  it('forces an OS banner for a run alert and adds no tray entry', () => {
    render(
      <>
        <BridgeHarness />
        <TrayProbe />
      </>
    );

    dispatchWorkspace(alertEvent({ runId: 'run-a' }));

    expect(os.showOsNotification).toHaveBeenCalledTimes(1);
    expect(os.showOsNotification.mock.calls[0]?.[0]).toMatchObject({
      id: 'notif-run-1',
      type: 'run_completed',
      title: 'Test Agent A completed',
      force: true,
    });
    // The alert itself is not a tray notification.
    expect(shown).toEqual([]);
  });

  it('maps a failed run onto the run_failed banner type', () => {
    render(<BridgeHarness />);
    dispatchWorkspace(alertEvent({ runId: 'run-b', status: 'failed' }));
    expect(os.showOsNotification.mock.calls[0]?.[0]).toMatchObject({ type: 'run_failed' });
  });

  it('stays silent about the thread this focused window is showing', () => {
    render(<BridgeHarness activeThreadId={ALERT_THREAD} />);

    dispatchWorkspace(alertEvent({ runId: 'run-c' }));

    expect(os.showOsNotification).not.toHaveBeenCalled();
    expect(sounds.playReminderSound).not.toHaveBeenCalled();
  });

  it('still alerts for that thread when the window is not focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    render(<BridgeHarness activeThreadId={ALERT_THREAD} />);

    dispatchWorkspace(alertEvent({ runId: 'run-d' }));

    expect(os.showOsNotification).toHaveBeenCalledTimes(1);
  });

  it('alerts when the window is showing a different thread', () => {
    render(<BridgeHarness activeThreadId="thread-2222222222222-bbbbbbbbb" />);
    dispatchWorkspace(alertEvent({ runId: 'run-e' }));
    expect(os.showOsNotification).toHaveBeenCalledTimes(1);
  });

  it('alerts once per run, so a duplicate event is ignored', () => {
    render(<BridgeHarness />);

    dispatchWorkspace(alertEvent({ runId: 'run-f' }));
    dispatchWorkspace(alertEvent({ runId: 'run-f' }));

    expect(os.showOsNotification).toHaveBeenCalledTimes(1);
  });

  it('plays the chosen sound in-app when no banner appeared (permission off or unsupported)', async () => {
    os.showOsNotification.mockResolvedValue({ shown: false, sounded: false });
    render(<BridgeHarness />);

    dispatchWorkspace(alertEvent({ runId: 'run-g', sound: 'marimba' }));
    await flush();

    expect(sounds.playReminderSound).toHaveBeenCalledTimes(1);
    expect(sounds.playReminderSound).toHaveBeenCalledWith('marimba');
  });

  it('leaves the sound to the OS banner when it sounds, so there is exactly one', async () => {
    os.showOsNotification.mockResolvedValue({ shown: true, sounded: true });
    render(<BridgeHarness />);

    dispatchWorkspace(alertEvent({ runId: 'run-h', sound: 'marimba' }));
    await flush();

    expect(os.showOsNotification).toHaveBeenCalledTimes(1);
    expect(sounds.playReminderSound).not.toHaveBeenCalled();
  });

  it('plays the in-app sound when the banner was shown silently', async () => {
    os.showOsNotification.mockResolvedValue({ shown: true, sounded: false });
    render(<BridgeHarness />);

    dispatchWorkspace(alertEvent({ runId: 'run-h2', sound: 'bell' }));
    await flush();

    expect(sounds.playReminderSound).toHaveBeenCalledTimes(1);
    expect(sounds.playReminderSound).toHaveBeenCalledWith('bell');
  });

  it('hands the thread’s chosen sound to the banner', () => {
    render(<BridgeHarness />);
    dispatchWorkspace(alertEvent({ runId: 'run-h3', sound: 'pulse' }));
    expect(os.showOsNotification.mock.calls[0]?.[0]).toMatchObject({ sound: 'pulse' });
  });

  it('opens the thread when the banner is clicked', () => {
    const onOpenThread = vi.fn();
    render(<BridgeHarness onOpenThread={onOpenThread} />);

    dispatchWorkspace(alertEvent({ runId: 'run-i' }));
    const call = os.showOsNotification.mock.calls[0]?.[0] as { onClick?: () => void };
    call.onClick?.();

    expect(onOpenThread).toHaveBeenCalledWith(ALERT_THREAD);
  });
});
