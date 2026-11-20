/**
 * AgentDmsTab — the agent page's Direct messages tab: this agent's
 * conversations listed with the other party's avatar and name (the user's own
 * labeled "Home thread"), the reading pane for the selected one, and the home
 * thread always present (created on first open).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent, WsMessage } from '@snaglet/shared/types';
import type { DmThreadSummary } from '@desktop/utils/api';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listDms: vi.fn(),
  openDm: vi.fn(),
}));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    agentsApi: { ...actual.agentsApi, list: (...a: unknown[]) => api.listAgents(...a) },
    threadsApi: {
      ...actual.threadsApi,
      listDms: (agentId?: string) => api.listDms(agentId),
      openDm: (agentId: string) => api.openDm(agentId),
    },
  };
});

// The reading pane has its own suite: a stub that can report its deletion.
vi.mock('../DmView', () => ({
  DmView: ({ threadId, onClosePane }: { threadId: string; onClosePane?: () => void }) => (
    <div data-testid="dm-pane" data-thread={threadId}>
      <button type="button" onClick={onClosePane}>
        pane-closed
      </button>
    </div>
  ),
}));

import { WebSocketContext, type WsContextValue } from '@desktop/ws/WebSocketContext';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { emitDmRead } from '@desktop/features/dms';
import { AgentDmsTab } from './AgentDmsTab';

const AGENT_ID = 'test-agent-a';
const OTHER_ID = 'test-agent-b';

function makeAgent(over: Partial<SnagletAgent> = {}): SnagletAgent {
  return { id: AGENT_ID, name: 'Test Agent A', ...over } as unknown as SnagletAgent;
}

function dm(over: Partial<DmThreadSummary> & { id: string }): DmThreadSummary {
  return {
    title: 'Test Agent A ↔ Test User',
    withName: 'Test User',
    withKind: 'user',
    withAgentId: undefined,
    unread: 0,
    lastMessageAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as DmThreadSummary;
}

const agentToAgent = dm({
  id: 'thread-dm-ab',
  title: 'Test Agent A ↔ Test Agent B',
  withName: 'Test Agent B',
  withKind: 'agent',
  withAgentId: OTHER_ID,
  unread: 5,
});

/** DM lists: the agent's own, and the user's. */
let lists: { agent: DmThreadSummary[]; user: DmThreadSummary[] };

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

function renderTab(agent: SnagletAgent = makeAgent()) {
  return render(
    <WebSocketContext.Provider value={ws}>
      <AgentDmsTab agent={agent} />
    </WebSocketContext.Provider>
  );
}

function messageArrives(threadId: string): void {
  act(() => {
    for (const listener of listeners) {
      listener({
        type: 'socket:chat:message_created',
        channel: threadId,
        payload: { id: `message-${Math.random()}`, threadId, role: 'assistant' },
      } as WsMessage);
    }
  });
}

/** Wait out the refresh debounce (300 ms) with room to spare. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 650));
  });

const WIDTH_KEY = 'snaglet.agent.dmTabListWidth';

/** The list's dragged width, handed to the stylesheet as a variable (a narrow tab stacks it). */
const listWidth = (column: HTMLElement) => column.style.getPropertyValue('--dm-list-width');

beforeEach(() => {
  window.localStorage.removeItem(WIDTH_KEY);
  vi.clearAllMocks();
  listeners = [];
  lists = { agent: [], user: [] };
  api.listAgents.mockResolvedValue([
    makeAgent(),
    makeAgent({ id: OTHER_ID, name: 'Test Agent B' }),
  ]);
  api.listDms.mockImplementation(async (agentId?: string) => (agentId ? lists.agent : lists.user));
});

describe('AgentDmsTab', () => {
  it('lists at the default width, drags within min/max, persists, resets and restores', async () => {
    lists.agent = [dm({ id: 'thread-dm-1' })];
    const first = renderTab();
    const column = await screen.findByTestId('dm-list-column');
    expect(listWidth(column)).toBe('176px');

    const handle = screen.getByRole('separator', { name: 'Resize conversation list' });
    fireEvent.pointerDown(handle, { button: 0, clientX: 200 });
    fireEvent.pointerMove(window, { clientX: 260 });
    expect(listWidth(column)).toBe('236px');
    fireEvent.pointerMove(window, { clientX: 2000 });
    expect(listWidth(column)).toBe('360px');
    fireEvent.pointerMove(window, { clientX: -2000 });
    expect(listWidth(column)).toBe('140px');
    fireEvent.pointerMove(window, { clientX: 230 });
    fireEvent.pointerUp(window);
    expect(listWidth(column)).toBe('206px');
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe('206');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(listWidth(column)).toBe('190px');

    first.unmount();
    renderTab();
    expect(listWidth(await screen.findByTestId('dm-list-column'))).toBe('190px');

    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize conversation list' }));
    expect(listWidth(screen.getByTestId('dm-list-column'))).toBe('176px');
  });

  it('lists the agent’s conversations, the user’s as Home thread, and shows it by default', async () => {
    const userThread = dm({ id: 'thread-dm-1' });
    lists.agent = [userThread, agentToAgent];
    lists.user = [{ ...userThread, withName: 'Test Agent A', withKind: 'agent', unread: 2 }];
    renderTab();

    const userRow = await screen.findByTestId('dm-row-user');
    expect(userRow).toHaveTextContent('Home thread');
    expect(userRow).not.toHaveTextContent('(you)');
    // The user draws no avatar of their own (DmAvatar renders none for them).
    expect(within(userRow).queryByTestId('dm-avatar')).toBeNull();
    await waitFor(() => expect(within(userRow).getByLabelText('2 unread')).toBeInTheDocument());

    const other = screen.getByTestId('dm-row-thread-dm-ab');
    expect(other).toHaveTextContent('Test Agent B');
    expect(other).not.toHaveTextContent('(you)');
    expect(within(other).getByTestId('dm-avatar')).toHaveAttribute('data-kind', 'agent');
    // The user is not in it: the agent's own unread is not the user's.
    expect(within(other).queryByLabelText(/unread/)).toBeNull();

    expect(await screen.findByTestId('dm-pane')).toHaveAttribute('data-thread', 'thread-dm-1');
    // Only the open row is marked and styled as selected.
    expect(userRow).toHaveAttribute('aria-selected', 'true');
    expect(userRow.className).toMatch(/rowSelected/);
    expect(other).toHaveAttribute('aria-selected', 'false');
    expect(other.className).not.toMatch(/rowSelected/);
  });

  it('selecting an agent-to-agent row shows its pane', async () => {
    lists.agent = [dm({ id: 'thread-dm-1' }), agentToAgent];
    renderTab();
    await screen.findByTestId('dm-pane');

    fireEvent.click(screen.getByTestId('dm-row-thread-dm-ab'));
    expect(screen.getByTestId('dm-pane')).toHaveAttribute('data-thread', 'thread-dm-ab');

    fireEvent.click(screen.getByTestId('dm-row-user'));
    expect(screen.getByTestId('dm-pane')).toHaveAttribute('data-thread', 'thread-dm-1');
  });

  it('always has the home thread row; the thread is created on first open', async () => {
    api.openDm.mockResolvedValue({ id: 'thread-dm-new', title: 'Test Agent A ↔ Test User' });
    renderTab();

    expect(await screen.findByTestId('dm-row-user')).toHaveTextContent('Home thread');
    expect(screen.getByText('No direct messages with Test Agent A yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('dm-pane')).toBeNull();
    expect(api.openDm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Message Test Agent A' }));
    await waitFor(() => expect(api.openDm).toHaveBeenCalledWith(AGENT_ID));
    expect(await screen.findByTestId('dm-pane')).toHaveAttribute('data-thread', 'thread-dm-new');
  });

  it('shows a note instead of a way to start when DMs are off', async () => {
    renderTab(makeAgent({ dmEnabled: false }));
    expect(await screen.findByText(/turned off for Test Agent A/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Message Test Agent A' })).toBeNull();
    expect(api.openDm).not.toHaveBeenCalled();
  });

  it('a deleted conversation drops, closes the pane and falls back to the create state', async () => {
    lists.agent = [dm({ id: 'thread-dm-1' }), agentToAgent];
    renderTab();
    expect(await screen.findByTestId('dm-pane')).toHaveAttribute('data-thread', 'thread-dm-1');

    // Deleted elsewhere: the thread-deleted event drops the row at once.
    lists.agent = [agentToAgent];
    act(() => emitLibraryEvent({ type: 'deleted', kind: 'thread', id: 'thread-dm-1' }));
    expect(screen.queryByTestId('dm-pane')).toBeNull();
    expect(screen.getByRole('button', { name: 'Message Test Agent A' })).toBeInTheDocument();
    expect(screen.getByTestId('dm-row-user')).toBeInTheDocument();

    // Deleted from the pane itself (an agent-to-agent thread): back to the user's row.
    fireEvent.click(screen.getByTestId('dm-row-thread-dm-ab'));
    expect(screen.getByTestId('dm-pane')).toHaveAttribute('data-thread', 'thread-dm-ab');
    lists.agent = [];
    fireEvent.click(screen.getByText('pane-closed'));
    expect(screen.queryByTestId('dm-row-thread-dm-ab')).toBeNull();
    expect(screen.queryByTestId('dm-pane')).toBeNull();
  });

  it('a burst of DM events makes one refresh: the agent’s list and the user’s, no per-agent N+1', async () => {
    lists.agent = [dm({ id: 'thread-dm-1' }), agentToAgent];
    renderTab();
    await screen.findByTestId('dm-pane');
    await settle();
    expect(api.listDms).toHaveBeenCalledTimes(2);
    expect(api.listDms).toHaveBeenCalledWith(AGENT_ID);
    expect(api.listDms).toHaveBeenCalledWith(undefined);
    expect(ws.subscribe).toHaveBeenCalledWith('thread-dm-1');
    api.listDms.mockClear();

    for (let i = 0; i < 5; i += 1) messageArrives(i % 2 === 0 ? 'thread-dm-1' : 'thread-dm-ab');
    act(() => emitDmRead('thread-dm-1'));
    await settle();

    expect(api.listDms).toHaveBeenCalledTimes(2);
  });
});

// The tab also lives in the agent preview modal, which can be narrower than
// a list plus a chat. Layout only, so the stylesheet is the contract.
describe('AgentDmsTab layout', () => {
  const scss = readFileSync(join(__dirname, 'AgentDmsTab.module.scss'), 'utf8');
  const rule = (selector: string, from = 0) => {
    const start = scss.indexOf(`${selector} {`, from);
    if (start < 0) throw new Error(`No ${selector} rule`);
    return scss.slice(start, scss.indexOf('}', start));
  };

  it('sizes the list from the dragged width and stacks it above the chat when narrow', () => {
    expect(scss).toMatch(/\.root \{\n(?: {2}\/\/.*\n)* {2}container: agent-dms \/ inline-size;/);
    expect(rule('\n.listColumn')).toMatch(/\n {2}width: var\(--dm-list-width\);/);
    const narrow = scss.indexOf('@container agent-dms (max-width: 520px) {');
    expect(narrow).toBeGreaterThan(0);
    expect(rule('.layout', narrow)).toMatch(/flex-direction: column;/);
    expect(rule('.listColumn', narrow)).toMatch(/width: auto;[\s\S]*border-bottom:/);
    expect(rule('.resizer', narrow)).toMatch(/display: none;/);
  });

  it('sets its rows in list text, not the page’s inherited 16px', () => {
    expect(rule('\n.row')).toMatch(
      /\n {2}font: inherit;\n(?: {2}\/\/.*\n)* {2}font-size: var\(--text-sm\);/
    );
  });
});
