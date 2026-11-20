/**
 * AgentMcpServers — the agent pane's MCP servers section follows changes made
 * outside it. Deleting or restoring a server (in another window, or by an
 * agent's `mcp` tool) sends `agent.updated` naming `mcpServers` for every
 * affected agent; the open pane refetches the agent's list and the server
 * list, so the server drops out or comes back without a reload. Events for
 * other agents or other fields change nothing.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnagletAgent } from '@snaglet/shared/types';
import { agentsApi, mcpServersApi, type McpServer } from '@desktop/utils/api';
import { AgentMcpServers } from './AgentMcpServers';

vi.mock('@desktop/utils/api', () => ({
  agentsApi: { get: vi.fn() },
  mcpServersApi: { list: vi.fn() },
}));

// Identity-stable WS context plus a captured-listener list the tests push
// frames through (mirrors AgentUtilityModelOverride.test.tsx).
const ws = vi.hoisted(() => {
  const listeners: Array<(message: unknown) => void> = [];
  return {
    listeners,
    ctx: {
      subscribe: () => {},
      unsubscribe: () => {},
      connectionState: 'open',
      addMessageListener: (fn: (message: unknown) => void) => {
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    },
  };
});
vi.mock('@desktop/ws/useWs', () => ({ useWs: () => ws.ctx }));

const getAgent = vi.mocked(agentsApi.get);
const listServers = vi.mocked(mcpServersApi.list);

const server = (id: string): McpServer =>
  ({ id, name: `Server ${id}`, enabled: true }) as unknown as McpServer;

function agentUpdated(agentId: string, changed: string[]) {
  return {
    channel: 'workspace',
    type: 'workspace_event',
    payload: {
      type: 'agent.updated',
      agentId,
      changed,
      ts: '2026-01-01T00:00:00.000Z',
      actor: { actorId: 'user-1', actorKind: 'user' },
    },
  };
}

async function push(frame: unknown): Promise<void> {
  await act(async () => {
    for (const listener of [...ws.listeners]) listener(frame);
  });
}

function checkbox(id: string): HTMLInputElement {
  const row = screen.getByText(id).closest('label');
  if (!row) throw new Error(`no row for ${id}`);
  const input = row.querySelector('input');
  if (!input) throw new Error(`no checkbox for ${id}`);
  return input;
}

beforeEach(() => {
  ws.listeners.length = 0;
  getAgent.mockReset();
  listServers.mockReset();
  listServers.mockResolvedValue([server('srv-a'), server('srv-b')]);
});

describe('AgentMcpServers — changes made elsewhere', () => {
  it('drops a deleted server and brings a restored one back on agent.updated', async () => {
    render(<AgentMcpServers agentId="agent-1" enabled={['srv-a', 'srv-b']} onSave={vi.fn()} />);
    await screen.findByText('srv-b');
    expect(checkbox('srv-b').checked).toBe(true);

    // srv-b is deleted elsewhere: the server prunes it from this agent.
    listServers.mockResolvedValue([server('srv-a')]);
    getAgent.mockResolvedValue({ id: 'agent-1', mcpServers: ['srv-a'] } as unknown as SnagletAgent);
    await push(agentUpdated('agent-1', ['mcpServers']));

    await waitFor(() => expect(screen.queryByText('srv-b')).toBeNull());
    expect(getAgent).toHaveBeenCalledWith('agent-1');
    expect(checkbox('srv-a').checked).toBe(true);

    // ...and restored: it is back, and on again for this agent.
    listServers.mockResolvedValue([server('srv-a'), server('srv-b')]);
    getAgent.mockResolvedValue({
      id: 'agent-1',
      mcpServers: ['srv-a', 'srv-b'],
    } as unknown as SnagletAgent);
    await push(agentUpdated('agent-1', ['mcpServers']));

    await waitFor(() => expect(checkbox('srv-b').checked).toBe(true));
  });

  it('turns a server off when only the grant changed elsewhere', async () => {
    render(<AgentMcpServers agentId="agent-1" enabled={['srv-a', 'srv-b']} onSave={vi.fn()} />);
    await screen.findByText('srv-a');

    getAgent.mockResolvedValue({ id: 'agent-1', mcpServers: ['srv-b'] } as unknown as SnagletAgent);
    await push(agentUpdated('agent-1', ['mcpServers']));

    await waitFor(() => expect(checkbox('srv-a').checked).toBe(false));
    expect(checkbox('srv-b').checked).toBe(true);
  });

  it('ignores other agents and other fields', async () => {
    render(<AgentMcpServers agentId="agent-1" enabled={['srv-a']} onSave={vi.fn()} />);
    await screen.findByText('srv-a');
    const listCalls = listServers.mock.calls.length;

    await push(agentUpdated('agent-other', ['mcpServers']));
    await push(agentUpdated('agent-1', ['role']));

    expect(getAgent).not.toHaveBeenCalled();
    expect(listServers).toHaveBeenCalledTimes(listCalls);
    expect(checkbox('srv-a').checked).toBe(true);
  });
});

describe('AgentMcpServers — saving a toggle', () => {
  it('puts the checkbox back and says why when the save fails', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('agent is locked'));
    render(<AgentMcpServers agentId="agent-1" enabled={['srv-a']} onSave={onSave} />);
    await screen.findByText('srv-b');

    fireEvent.click(checkbox('srv-b'));

    expect(await screen.findByRole('alert')).toHaveTextContent('agent is locked');
    expect(onSave).toHaveBeenCalledWith(['srv-a', 'srv-b']);
    expect(checkbox('srv-b').checked).toBe(false);
  });

  it('keeps the second of two quick toggles while its save is still running', async () => {
    const saves: Array<() => void> = [];
    const onSave = vi.fn(() => new Promise<void>((resolve) => saves.push(() => resolve())));
    const { rerender } = render(<AgentMcpServers agentId="agent-1" enabled={[]} onSave={onSave} />);
    await screen.findByText('srv-b');

    fireEvent.click(checkbox('srv-a'));
    fireEvent.click(checkbox('srv-b'));
    expect(onSave).toHaveBeenLastCalledWith(['srv-a', 'srv-b']);

    // The first save lands; the parent adopts its (older) list.
    await act(async () => saves[0]());
    rerender(<AgentMcpServers agentId="agent-1" enabled={['srv-a']} onSave={onSave} />);

    expect(checkbox('srv-a').checked).toBe(true);
    expect(checkbox('srv-b').checked).toBe(true);
  });
});
