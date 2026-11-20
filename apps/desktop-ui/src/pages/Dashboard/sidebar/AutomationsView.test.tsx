import { checkSidebarDisclosures } from '@desktop/test/sidebarDisclosure';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FC, ReactNode } from 'react';
import type { WsMessage } from '@snaglet/shared/types';
import { WORKSPACE_EVENT_CHANNEL } from '@snaglet/shared/types/workspace-events';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  remove: vi.fn(),
  recentRuns: vi.fn(),
}));
vi.mock('@desktop/utils/api/automations', () => ({ automationsApi: api }));

// Scripts: folders, registrations (on/off, build state) and what each declares.
const scriptsApi = vi.hoisted(() => ({
  list: vi.fn(),
  registry: vi.fn(),
  setEnabled: vi.fn(),
  delete: vi.fn(),
  // MoveHookToTrashModal reads the folder to show where the code lives.
  get: vi.fn(),
}));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, hooksWorkspacesApi: scriptsApi };
});

type ToastAction = { label: string; run: () => void };
const toast = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@desktop/utils/toast', () => ({
  showToast: (...args: unknown[]) => toast.show(...args),
  dismissToast: vi.fn(),
}));

import { WebSocketContext, type WsContextValue } from '@desktop/ws/WebSocketContext';
import {
  __resetAutomationsStoreForTests,
  useAutomationsFeed,
} from '@desktop/features/automations/automationsStore';
import { automationRecord } from '@desktop/features/automations/testFixtures';
import type { HookWorkspaceInfo } from '@desktop/utils/api';
import { __resetRecentAutomationRunsForTests } from '@desktop/features/automations/recentRunsStore';
import { seedHookRuns } from '@desktop/utils/hookRunState';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import {
  emitLibraryEvent,
  onLibraryEvent,
  type LibraryEvent,
} from '@desktop/utils/workspaceEvents';
import { ArchiveDropZone } from '../components/ArchiveDropZone';
import { AutomationsView } from './AutomationsView';

const active = automationRecord({ id: 'automation-1', name: 'Morning check' });
const paused = automationRecord({
  id: 'automation-2',
  name: 'Flaky build',
  status: 'paused',
  pausedReason: 'failures',
  consecutiveFailures: 3,
  nextRunAt: null,
});
const pausedByHand = automationRecord({
  id: 'automation-3',
  name: 'Weekly digest',
  status: 'paused',
  pausedReason: 'user',
  nextRunAt: null,
});
const finished = automationRecord({
  id: 'automation-4',
  name: 'One-off reminder',
  status: 'finished',
  nextRunAt: null,
});
const deleted = automationRecord({ id: 'automation-5', name: 'Gone', status: 'cancelled' });

let listeners: Array<(message: WsMessage) => void> = [];
const ws: WsContextValue = {
  connectionState: 'open',
  serverRestarting: false,
  send: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  addMessageListener: (listener) => {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  },
};

const Feed: FC<{ children: ReactNode }> = ({ children }) => {
  useAutomationsFeed();
  return <>{children}</>;
};

type ViewProps = Parameters<typeof AutomationsView>[0];

function viewProps(props: Partial<ViewProps> = {}): ViewProps {
  return {
    onOpen: vi.fn(),
    onCreate: vi.fn(),
    onScriptOpen: vi.fn(),
    onScriptCreate: vi.fn(),
    activeAutomationId: null,
    ...props,
  };
}

function renderView(props: Partial<ViewProps> = {}) {
  const all = viewProps(props);
  const utils = render(
    <WebSocketContext.Provider value={ws}>
      <Feed>
        <AutomationsView {...all} />
      </Feed>
    </WebSocketContext.Provider>
  );
  return { ...all, ...utils };
}

function makeScript(hookName: string): HookWorkspaceInfo {
  return {
    hookName,
    dir: `/tmp/snaglet-test/hooks/${hookName}`,
    homeRelativeDir: `~/.snaglet/hooks/${hookName}`,
    files: ['hook.ts'],
    hasBuild: true,
  };
}

function registration(
  name: string,
  enabled: boolean,
  declared: { events: string[]; schedules: unknown[] } | null = null,
  buildStatus = 'ready',
  lastError: string | null = null
) {
  return { id: `registration-${name}`, name, enabled, buildStatus, lastError, declared };
}

/** Every library event the view sends while a test runs. */
let sent: LibraryEvent[] = [];
let stopListening: () => void = () => undefined;

beforeEach(() => {
  scriptsApi.list.mockReset().mockResolvedValue([]);
  scriptsApi.registry.mockReset().mockResolvedValue([]);
  scriptsApi.setEnabled.mockReset();
  scriptsApi.delete.mockReset();
  scriptsApi.get.mockReset().mockImplementation(async (name: string) => makeScript(name));
  api.recentRuns.mockReset().mockResolvedValue({ runs: [] });
  __resetRecentAutomationRunsForTests();
  seedHookRuns([]);
  sent = [];
  stopListening = onLibraryEvent((event) => void sent.push(event));
});
afterEach(() => stopListening());

const group = (label: string) =>
  screen.getByText(label, { selector: 'span' }).closest('[role="button"]') as HTMLElement;

describe('AutomationsView', () => {
  it('native disclosure changes status groups without pause/resume/open', async () => {
    api.list.mockResolvedValue({ automations: [active, paused] });
    const view = renderView();
    await screen.findByText('Morning check');
    await checkSidebarDisclosures(view.container, 'automations');
    expect(view.onOpen).not.toHaveBeenCalled();
    expect(api.pause).not.toHaveBeenCalled();
    expect(api.resume).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    __resetAutomationsStoreForTests();
    listeners = [];
    api.list.mockReset();
    api.pause.mockReset();
    api.resume.mockReset();
    api.remove.mockReset();
    toast.show.mockReset();
  });

  it('drags a row onto the sidebar trash: it is archived and leaves the list', async () => {
    api.list.mockResolvedValue({ automations: [active, paused] });
    api.remove.mockResolvedValue({
      automation: { ...active, status: 'cancelled', nextRunAt: null, scheduleId: null },
    });
    const view = render(
      <WebSocketContext.Provider value={ws}>
        <Feed>
          <AutomationsView {...viewProps()} />
          <ArchiveDropZone onToggleDrawer={vi.fn()} drawerOpen={false} />
        </Feed>
      </WebSocketContext.Provider>
    );
    const row = await screen.findByTestId('automation-row-automation-1');
    expect(row).toHaveAttribute('draggable', 'true');

    // One DataTransfer carries the drag from the row to the trash.
    const values = new Map<string, string>();
    const transfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      get types() {
        return [...values.keys()];
      },
      getData: (type: string) => values.get(type) ?? '',
      setData: (type: string, value: string) => void values.set(type, value),
    };
    fireEvent.dragStart(row, { dataTransfer: transfer });
    // A pane split still takes it (the pane payload), and the trash knows it as an automation.
    expect(JSON.parse(values.get(PANE_ITEM_MIME) ?? '{}')).toMatchObject({
      kind: 'automation-detail',
      automation_id: 'automation-1',
    });
    expect(JSON.parse(values.get('application/x-snaglet-tree-node') ?? '[]')).toEqual([
      { id: 'automation-1', kind: 'automation', label: 'Morning check' },
    ]);

    const zone = view.getByTestId('archive-drop-zone');
    fireEvent.dragOver(zone, { dataTransfer: transfer });
    fireEvent.drop(zone, { dataTransfer: transfer });

    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('automation-1'));
    await waitFor(() => expect(screen.queryByText('Morning check')).toBeNull());
    expect(screen.getByText('Flaky build')).toBeInTheDocument();
    expect(within(zone).getByRole('status')).toHaveTextContent('Archived 1 item');
  });

  it('groups by status with counts, and lists no deleted ones', async () => {
    api.list.mockResolvedValue({ automations: [active, paused, pausedByHand, finished, deleted] });
    renderView();

    await screen.findByText('Morning check');
    expect(within(group('Active')).getByText('1')).toBeInTheDocument();
    expect(within(group('Paused or off')).getByText('2')).toBeInTheDocument();
    expect(within(group('Finished')).getByText('1')).toBeInTheDocument();
    expect(screen.queryByText('Gone')).toBeNull();

    // The row as a sentence, then the next run on active rows; why on paused ones.
    const row = screen.getByTestId('automation-row-automation-1');
    expect(row).toHaveTextContent(
      'Every weekday at 9:00 AM → wake Test Agent A in Test thread · next'
    );
    expect(screen.getByTestId('automation-row-automation-2')).toHaveTextContent(
      'Paused after 3 failures'
    );
    expect(screen.getByTestId('automation-row-automation-3')).toHaveTextContent(/· Paused$/);

    // Group headers collapse and reopen.
    fireEvent.click(group('Paused or off'));
    expect(screen.queryByText('Flaky build')).toBeNull();
    fireEvent.click(group('Paused or off'));
    expect(screen.getByText('Flaky build')).toBeInTheDocument();
  });

  it('drags New automation or New script from the + menu into a pane split', async () => {
    api.list.mockResolvedValue({ automations: [active] });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'New automation or script' }));

    for (const [label, kind] of [
      ['New automation', 'automation-create'],
      ['New script', 'hook-create'],
    ] as const) {
      const setData = vi.fn();
      const dataTransfer = { setData, effectAllowed: 'none' };
      fireEvent.dragStart(screen.getByRole('menuitem', { name: label }), { dataTransfer });
      expect(setData).toHaveBeenCalledWith(PANE_ITEM_MIME, JSON.stringify({ kind }));
      expect(dataTransfer.effectAllowed).toBe('all');
    }
  });

  it('reports the list as loading to the sidebar tool until the scripts answer too', async () => {
    api.list.mockResolvedValue({ automations: [active] });
    let answer: (rows: unknown[]) => void = () => undefined;
    scriptsApi.list.mockReturnValue(new Promise((done) => (answer = done)));
    const { container } = renderView();
    await screen.findByText('Morning check');
    const tree = () => container.querySelector('[data-sidebar-mounted]');
    expect(tree()).toHaveAttribute('data-sidebar-mounted', 'loading');

    await act(async () => answer([makeScript('test-script-a')]));
    await waitFor(() => expect(tree()).toHaveAttribute('data-sidebar-mounted', 'ready'));
  });

  it('says a first-open one runs when Snaglet first opens, as the pane does', async () => {
    api.list.mockResolvedValue({
      automations: [
        automationRecord({
          id: 'automation-7',
          name: 'Daily check-in',
          when: { kind: 'first_open', after: '05:00', tz: 'UTC' },
          whenText: 'when Snaglet first opens, after 5:00 AM',
          nextRunAt: '2026-11-06T05:00:00.000Z',
        }),
      ],
    });
    renderView();

    const row = await screen.findByTestId('automation-row-automation-7');
    expect(row).toHaveTextContent(
      'When Snaglet first opens, after 5:00 AM → wake Test Agent A in Test thread · next when Snaglet first opens, from '
    );
  });

  it('says how automations get made when there are none, and + offers an automation or a script', async () => {
    api.list.mockResolvedValue({ automations: [deleted] });
    const { onCreate, onScriptCreate } = renderView();

    expect(
      await screen.findByText(/No automations yet\. Agents create them when you ask/)
    ).toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'New automation or script' });
    fireEvent.click(add);
    const menu = screen.getByRole('menu', { name: 'New automation or script' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['New automation', 'New script']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'New automation' }));
    expect(onCreate).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(add);
    fireEvent.click(screen.getByRole('menuitem', { name: 'New script' }));
    expect(onScriptCreate).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('opens a row on click or Enter, moves with the arrow keys, and marks the open one', async () => {
    api.list.mockResolvedValue({ automations: [active, paused] });
    const { onOpen } = renderView({ activeAutomationId: 'automation-2' });

    const first = await screen.findByTestId('automation-row-automation-1');
    const second = screen.getByTestId('automation-row-automation-2');
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(first);
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'automation-1' }));

    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    // Next stop is the Paused group header, then its row.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'Enter' });
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'automation-2' }));
  });

  it('shows changes agents make, and a running wake, without a reload', async () => {
    api.list.mockResolvedValueOnce({ automations: [active] });
    renderView();
    await screen.findByText('Morning check');
    expect(screen.queryByText('Running')).toBeNull();

    api.list.mockResolvedValueOnce({
      automations: [
        { ...active, running: true, runningSince: '2026-10-14T09:00:00.000Z' },
        automationRecord({ id: 'automation-6', name: 'Made by an agent' }),
      ],
    });
    act(() => {
      for (const listener of listeners) {
        listener({
          channel: WORKSPACE_EVENT_CHANNEL,
          type: 'automations:changed',
          payload: { automationId: 'automation-6' },
        });
      }
    });

    expect(await screen.findByText('Made by an agent')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(screen.getByTestId('automation-row-automation-1')).getByRole('status')
      ).toHaveTextContent('Running')
    );
  });

  it('pauses an active row from its button, with Undo, without opening it', async () => {
    api.list.mockResolvedValue({ automations: [active, paused, finished] });
    api.pause.mockResolvedValue({
      automation: { ...active, status: 'paused', pausedReason: 'user', nextRunAt: null },
    });
    api.resume.mockResolvedValue({ automation: active });
    const { onOpen } = renderView();

    const pause = await screen.findByRole('button', { name: 'Pause Morning check' });
    expect(within(screen.getByTestId('automation-row-automation-1')).getByRole('button')).toBe(
      pause
    );
    fireEvent.click(pause);
    expect(onOpen).not.toHaveBeenCalled();
    expect(api.pause).toHaveBeenCalledWith('automation-1');

    // It moves to Paused or off, where it offers Resume.
    expect(await screen.findByRole('button', { name: 'Resume Morning check' })).toBeInTheDocument();
    expect(within(group('Paused or off')).getByText('2')).toBeInTheDocument();
    const calls = toast.show.mock.calls as Array<[string, { action?: ToastAction } | undefined]>;
    const [message, options] = calls[calls.length - 1] ?? [];
    expect(message).toBe('Paused Morning check');
    expect(options?.action?.label).toBe('Undo');

    api.list.mockClear();
    await act(async () => options?.action?.run());
    expect(api.resume).toHaveBeenCalledWith('automation-1');
    await waitFor(() => expect(api.list).toHaveBeenCalled());
  });

  it('resumes a paused row, offers nothing on finished ones, and keeps the button still while it works', async () => {
    api.list.mockResolvedValue({ automations: [paused, finished] });
    let settle: (value: unknown) => void = () => undefined;
    api.resume.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const { onOpen } = renderView();

    const resume = await screen.findByRole('button', { name: 'Resume Flaky build' });
    expect(
      within(screen.getByTestId('automation-row-automation-4')).queryByRole('button')
    ).toBeNull();

    fireEvent.click(resume);
    expect(api.resume).toHaveBeenCalledWith('automation-2');
    expect(resume).toBeDisabled();
    fireEvent.click(resume);
    expect(api.resume).toHaveBeenCalledTimes(1);

    await act(async () =>
      settle({ automation: { ...paused, status: 'active', pausedReason: null } })
    );
    expect(await screen.findByRole('button', { name: 'Pause Flaky build' })).not.toBeDisabled();
    expect(toast.show).toHaveBeenLastCalledWith('Resumed Flaky build', expect.anything());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('presses the button from the keyboard without opening the row, and says when it fails', async () => {
    api.list.mockResolvedValue({ automations: [active] });
    api.pause.mockRejectedValue(new Error('Server unavailable'));
    const { onOpen } = renderView();

    const pause = await screen.findByRole('button', { name: 'Pause Morning check' });
    fireEvent.keyDown(pause, { key: 'Enter' });
    fireEvent.keyDown(pause, { key: ' ' });
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(pause);
    await waitFor(() => expect(toast.show).toHaveBeenCalledWith('Server unavailable'));
    expect(pause).not.toBeDisabled();
  });
});

describe('AutomationsView reveal', () => {
  const flush = () =>
    act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
  const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
  const emitChanged = () =>
    act(async () => {
      for (const listener of listeners) {
        listener({
          channel: WORKSPACE_EVENT_CHANNEL,
          type: 'automations:changed',
          payload: { automationId: 'automation-1' },
        });
      }
    });
  const pulsing = () =>
    screen.getByTestId('automation-row-automation-1').className.includes('Reveal');

  beforeEach(() => {
    __resetAutomationsStoreForTests();
    listeners = [];
    api.list.mockReset();
    // Only the timers under test: the store's promises and waitFor stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pulses the revealed row once per request, not again on each automations:changed', async () => {
    api.list.mockImplementation(async () => ({ automations: [active, paused] })); // a fresh array per read, like the API
    renderView({ revealNodeId: 'automation-1', revealNonce: 1 });
    await flush();
    await flush();
    await advance(60);
    expect(pulsing()).toBe(true);
    await advance(1600);
    expect(pulsing()).toBe(false);

    // A change elsewhere refetches the list (a new array) — the pulse stays off.
    const reads = api.list.mock.calls.length;
    await emitChanged();
    await flush();
    expect(api.list.mock.calls.length).toBeGreaterThan(reads); // the list really was re-read
    await advance(60);
    expect(pulsing()).toBe(false);
    await emitChanged();
    await flush();
    await advance(2000);
    expect(pulsing()).toBe(false);
  });

  it('pulses again when the same row is revealed again (new nonce)', async () => {
    api.list.mockImplementation(async () => ({ automations: [active] }));
    const { rerender } = renderView({ revealNodeId: 'automation-1', revealNonce: 1 });
    await flush();
    await flush();
    await advance(60);
    await advance(1600);
    expect(pulsing()).toBe(false);

    rerender(
      <WebSocketContext.Provider value={ws}>
        <Feed>
          <AutomationsView {...viewProps({ revealNodeId: 'automation-1', revealNonce: 2 })} />
        </Feed>
      </WebSocketContext.Provider>
    );
    await advance(60);
    expect(pulsing()).toBe(true);
  });

  it('clears the pulse timeout when it unmounts mid-pulse', async () => {
    api.list.mockImplementation(async () => ({ automations: [active] }));
    const { unmount } = renderView({ revealNodeId: 'automation-1', revealNonce: 1 });
    await flush();
    await flush();
    await advance(60);
    expect(pulsing()).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('AutomationsView scripts', () => {
  const scriptRow = (name: string) => screen.getByTestId(`script-row-${name}`);
  const switchFor = (name: string) =>
    screen.findByRole('switch', { name: `Run ${name} automatically` });

  beforeEach(() => {
    __resetAutomationsStoreForTests();
    listeners = [];
    api.list.mockReset().mockResolvedValue({ automations: [active] });
    scriptsApi.list.mockResolvedValue([
      makeScript('test-script-a'),
      makeScript('test-script-b'),
      makeScript('test-script-new'),
    ]);
    scriptsApi.registry.mockResolvedValue([
      registration('test-script-a', true, {
        events: ['table_entry:create', 'table_entry:update'],
        schedules: [],
      }),
      registration('test-script-b', false, { events: ['run:end'], schedules: [] }),
    ]);
  });

  it('lists scripts with the automations, each as a sentence, on ones under Active', async () => {
    renderView();

    expect(await screen.findByText('test-script-a')).toBeInTheDocument();
    await waitFor(() =>
      expect(scriptRow('test-script-a')).toHaveTextContent(
        'When a table row is created or changed → run test-script-a'
      )
    );
    expect(scriptRow('test-script-b')).toHaveTextContent('When a run ends → run test-script-b');
    // One list: the automation and the on script share Active, sorted by name.
    expect(
      screen
        .getAllByRole('treeitem')
        .slice(0, 2)
        .map((row) => row.getAttribute('data-testid'))
    ).toEqual(['automation-row-automation-1', 'script-row-test-script-a']);
    expect(within(group('Active')).getByText('2')).toBeInTheDocument();
    // Off and not-yet-registered scripts list with the paused ones.
    expect(within(group('Paused or off')).getByText('2')).toBeInTheDocument();
    expect(scriptRow('test-script-new')).toHaveTextContent('Run test-script-new · Not built yet');
  });

  it('says when a script failed to build, with the error on hover', async () => {
    scriptsApi.registry.mockResolvedValue([
      registration('test-script-a', true, null, 'failed', 'Unexpected token'),
    ]);
    renderView();

    const note = await screen.findByText('Build failed');
    expect(note).toHaveAttribute('title', 'Unexpected token');
    expect(scriptRow('test-script-a')).toHaveTextContent('Run test-script-a · Build failed');
  });

  it('shows each registered script on or off, mutes the off ones, and skips unregistered ones', async () => {
    renderView();

    expect(await switchFor('test-script-a')).toHaveAttribute('aria-checked', 'true');
    expect(await switchFor('test-script-b')).toHaveAttribute('aria-checked', 'false');
    expect(scriptRow('test-script-a').className).not.toMatch(/rowDimmed/);
    expect(scriptRow('test-script-b').className).toMatch(/rowDimmed/);
    expect(screen.queryByRole('switch', { name: 'Run test-script-new automatically' })).toBeNull();
  });

  it('flips at once, saves and tells other surfaces, without opening the script', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    scriptsApi.setEnabled.mockReturnValue(new Promise((done) => (resolve = done)));
    const { onScriptOpen } = renderView();

    fireEvent.click(await switchFor('test-script-a'));
    expect(await switchFor('test-script-a')).toHaveAttribute('aria-checked', 'false');
    expect(scriptsApi.setEnabled).toHaveBeenCalledWith('test-script-a', false);
    expect(onScriptOpen).not.toHaveBeenCalled();

    await act(async () => resolve(registration('test-script-a', false)));
    expect(sent).toContainEqual({
      type: 'hook-enabled-changed',
      hookName: 'test-script-a',
      enabled: false,
    });
    // Off now, so it moves to Paused or off.
    expect(within(group('Paused or off')).getByText('3')).toBeInTheDocument();
    expect(await switchFor('test-script-a')).not.toBeDisabled();
  });

  it('flips back and says why when the change fails', async () => {
    scriptsApi.setEnabled.mockRejectedValue(new Error('registry is locked'));
    renderView();

    fireEvent.click(await switchFor('test-script-b'));

    expect(await screen.findByRole('alert')).toHaveTextContent('registry is locked');
    expect(await switchFor('test-script-b')).toHaveAttribute('aria-checked', 'false');
    expect(sent.some((event) => event.type === 'hook-enabled-changed')).toBe(false);
  });

  it('follows a flip made elsewhere (the script page, the CLI, another window)', async () => {
    renderView();
    expect(await switchFor('test-script-b')).toHaveAttribute('aria-checked', 'false');

    act(() =>
      emitLibraryEvent({ type: 'hook-enabled-changed', hookName: 'test-script-b', enabled: true })
    );

    expect(await switchFor('test-script-b')).toHaveAttribute('aria-checked', 'true');
    expect(scriptRow('test-script-b').className).not.toMatch(/rowDimmed/);
  });

  it('still lists scripts when the registrations cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    scriptsApi.registry.mockRejectedValue(new Error('offline'));
    renderView();

    expect(await screen.findByText('test-script-a')).toBeInTheDocument();
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(screen.queryByRole('switch')).toBeNull();
    error.mockRestore();
  });

  it('a row, Enter on it, and its pencil open the script page; the row drags to a pane and the trash', async () => {
    const { onScriptOpen } = renderView({ activeScriptName: 'test-script-b' });
    const row = await screen.findByTestId('script-row-test-script-a');
    expect(scriptRow('test-script-b')).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(row);
    expect(onScriptOpen).toHaveBeenLastCalledWith(makeScript('test-script-a'));
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onScriptOpen).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Edit test-script-a' }));
    expect(onScriptOpen).toHaveBeenCalledTimes(3);

    const setData = vi.fn();
    fireEvent.dragStart(row, {
      dataTransfer: { setData, getData: () => '', effectAllowed: 'none' },
    });
    expect(setData).toHaveBeenCalledWith(
      PANE_ITEM_MIME,
      JSON.stringify({ kind: 'hook', hook: makeScript('test-script-a') })
    );
    expect(setData).toHaveBeenCalledWith(
      'application/x-snaglet-tree-node',
      JSON.stringify([{ id: 'test-script-a', kind: 'hook' }])
    );
  });

  it('follows the script page: a save patches the row (a rename replaces it), a Trash drops it', async () => {
    renderView();
    await screen.findByText('test-script-a');

    // The folder is renamed on disk, so the next read lists the new name.
    scriptsApi.list.mockResolvedValue([
      makeScript('test-script-renamed'),
      makeScript('test-script-b'),
      makeScript('test-script-new'),
    ]);
    act(() =>
      emitLibraryEvent({
        type: 'hook-saved',
        hook: makeScript('test-script-renamed'),
        previousHookName: 'test-script-a',
      })
    );
    expect(await screen.findByText('test-script-renamed')).toBeInTheDocument();
    expect(screen.queryByText('test-script-a')).toBeNull();
    // New code may declare other events: the registry is read again.
    await waitFor(() => expect(scriptsApi.registry).toHaveBeenCalledTimes(2));

    act(() => emitLibraryEvent({ type: 'hook-deleted', hookName: 'test-script-b' }));
    await waitFor(() => expect(screen.queryByText('test-script-b')).toBeNull());
  });

  it('follows the registry: a script an agent creates appears, and its build shows when it ends', async () => {
    renderView();
    await screen.findByText('test-script-a');
    expect(screen.queryByText('test-script-made-by-agent')).toBeNull();

    // The folder appears and starts building.
    scriptsApi.list.mockResolvedValue([
      makeScript('test-script-a'),
      makeScript('test-script-b'),
      makeScript('test-script-made-by-agent'),
    ]);
    scriptsApi.registry.mockResolvedValue([
      registration('test-script-made-by-agent', false, null, 'building'),
    ]);
    act(() =>
      emitLibraryEvent({ type: 'hook-registry-changed', hookNames: ['test-script-made-by-agent'] })
    );
    await waitFor(() =>
      expect(scriptRow('test-script-made-by-agent')).toHaveTextContent(
        'Run test-script-made-by-agent · Building…'
      )
    );

    // The build ends: its switch and its sentence show, no reload.
    scriptsApi.registry.mockResolvedValue([
      registration('test-script-made-by-agent', false, { events: ['run:end'], schedules: [] }),
    ]);
    act(() =>
      emitLibraryEvent({ type: 'hook-registry-changed', hookNames: ['test-script-made-by-agent'] })
    );
    expect(await switchFor('test-script-made-by-agent')).toHaveAttribute('aria-checked', 'false');
    expect(scriptRow('test-script-made-by-agent')).toHaveTextContent(
      'When a run ends → run test-script-made-by-agent'
    );
  });

  it('reads at most twice for a burst of registry events', async () => {
    renderView();
    await screen.findByText('test-script-a');
    await waitFor(() => expect(scriptsApi.registry).toHaveBeenCalledTimes(1));

    let release: () => void = () => undefined;
    scriptsApi.registry.mockImplementation(
      () =>
        new Promise((done) => {
          release = () => done([registration('test-script-a', true)]);
        })
    );
    act(() => {
      for (let i = 0; i < 5; i++) {
        emitLibraryEvent({ type: 'hook-registry-changed', hookNames: ['test-script-a'] });
      }
    });
    expect(scriptsApi.registry).toHaveBeenCalledTimes(2);
    await act(async () => release());
    await waitFor(() => expect(scriptsApi.registry).toHaveBeenCalledTimes(3));
    await act(async () => release());
    expect(scriptsApi.registry).toHaveBeenCalledTimes(3);
  });

  it('its trash opens the move-to-Trash modal; confirming removes it and tells other surfaces', async () => {
    scriptsApi.delete.mockResolvedValue({
      hookName: 'test-script-a',
      deletedRuns: 0,
      deletedRegistration: true,
      deletedSchedules: 0,
      trash: { disposition: 'system-trash', fallbackDir: null },
    });
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete test-script-a' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(/move .test-script-a. to the trash\?/i);
    await screen.findByText('~/.snaglet/hooks/test-script-a');
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }));

    await waitFor(() => expect(screen.queryByText('test-script-a')).toBeNull());
    expect(scriptsApi.delete).toHaveBeenCalledWith('test-script-a');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sent).toContainEqual({ type: 'hook-deleted', hookName: 'test-script-a' });
  });

  it('canceling the modal deletes nothing', async () => {
    renderView();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete test-script-a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(scriptsApi.delete).not.toHaveBeenCalled();
    expect(screen.getByText('test-script-a')).toBeInTheDocument();
  });

  it('reveals a script by its name: opens its group and pulses its row', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { rerender } = renderView();
    await screen.findByText('test-script-b');
    fireEvent.click(group('Paused or off'));
    expect(screen.queryByText('test-script-b')).toBeNull();

    rerender(
      <WebSocketContext.Provider value={ws}>
        <Feed>
          <AutomationsView {...viewProps({ revealNodeId: 'test-script-b', revealNonce: 1 })} />
        </Feed>
      </WebSocketContext.Provider>
    );

    expect(await screen.findByText('test-script-b')).toBeInTheDocument();
    await waitFor(() => expect(scriptRow('test-script-b').className).toMatch(/Reveal/));
  });
});

describe('AutomationsView run log', () => {
  const recentRun = (over: Record<string, unknown> = {}) => ({
    id: 'run-a1',
    automationId: 'automation-1',
    automationName: 'Morning check',
    scheduledFor: '2026-11-05T09:00:00.000Z',
    startedAt: '2026-11-05T09:00:00.000Z',
    finishedAt: '2026-11-05T09:00:12.000Z',
    status: 'succeeded',
    error: null,
    manual: false,
    ...over,
  });
  const changed = () =>
    act(() => {
      for (const listener of listeners) {
        listener({
          channel: WORKSPACE_EVENT_CHANNEL,
          type: 'automations:changed',
          payload: { automationId: 'automation-1' },
        });
      }
    });

  beforeEach(() => {
    __resetAutomationsStoreForTests();
    listeners = [];
    api.list.mockReset().mockResolvedValue({ automations: [active, paused] });
    scriptsApi.list.mockResolvedValue([makeScript('test-script-a')]);
  });

  it('lists automation and script runs together, newest first, and a line opens what ran', async () => {
    api.recentRuns.mockResolvedValue({ runs: [recentRun()] });
    seedHookRuns([
      {
        id: 'run-s1',
        hookName: 'test-script-a',
        source: 'event',
        eventName: 'table_entry:update',
        status: 'failed',
        agentId: null,
        threadId: null,
        durationMs: 450,
        exitCode: 1,
        stdout: null,
        stderr: 'boom',
        startedAt: '2026-11-05T10:00:00.000Z',
        finishedAt: '2026-11-05T10:00:00.450Z',
      },
    ]);
    const { onOpen, onScriptOpen } = renderView();

    const scriptLine = await screen.findByTestId('run-row-script:run-s1');
    const automationLine = await screen.findByTestId('run-row-automation:run-a1');
    // One read for every automation, not one per automation.
    expect(api.recentRuns).toHaveBeenCalledTimes(1);
    expect(api.recentRuns).toHaveBeenCalledWith(20);
    // Newest first.
    expect(scriptLine.compareDocumentPosition(automationLine)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(scriptLine).toHaveTextContent('test-script-a');
    expect(scriptLine).toHaveTextContent(/Row changed · Failed · 450 ms · /);
    expect(automationLine).toHaveTextContent('Morning check');
    expect(automationLine).toHaveTextContent(/Schedule · Ran · 12 s · /);

    fireEvent.click(scriptLine);
    expect(onScriptOpen).toHaveBeenCalledWith(makeScript('test-script-a'));
    fireEvent.click(automationLine);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'automation-1' }));
  });

  it('keeps the runs across a tab switch and reads again only when a run starts or ends', async () => {
    api.recentRuns.mockResolvedValue({ runs: [recentRun()] });
    const first = renderView();
    await screen.findByTestId('run-row-automation:run-a1');
    first.unmount();

    // Back on the tab, nothing ran: no read.
    renderView();
    await screen.findByTestId('run-row-automation:run-a1');
    expect(api.recentRuns).toHaveBeenCalledTimes(1);

    // An edit that is not a run (a rename) reads nothing; the line follows the name.
    api.list.mockResolvedValue({
      automations: [{ ...active, name: 'Renamed check' }, paused],
    });
    changed();
    await waitFor(() =>
      expect(screen.getByTestId('run-row-automation:run-a1')).toHaveTextContent('Renamed check')
    );
    expect(api.recentRuns).toHaveBeenCalledTimes(1);

    // A wake starts: one read.
    api.list.mockResolvedValue({
      automations: [{ ...active, running: true, runningSince: '2026-11-05T10:00:00.000Z' }, paused],
    });
    api.recentRuns.mockResolvedValue({
      runs: [
        recentRun({ id: 'run-a2', startedAt: '2026-11-05T10:00:00.000Z', status: 'running' }),
        recentRun(),
      ],
    });
    changed();
    expect(await screen.findByTestId('run-row-automation:run-a2')).toHaveTextContent(
      /Schedule · Running · /
    );
    expect(api.recentRuns).toHaveBeenCalledTimes(2);
  });

  it('says when the runs did not load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    api.recentRuns.mockRejectedValue(new Error('offline'));
    renderView();
    expect(await screen.findByText('Automation runs did not load.')).toBeInTheDocument();
    warn.mockRestore();
  });

  it('says so when nothing has run, and collapses like the other groups', async () => {
    renderView();
    expect(await screen.findByText('No runs yet.')).toBeInTheDocument();
    fireEvent.click(group('Recent runs'));
    expect(screen.queryByText('No runs yet.')).toBeNull();
  });
});
