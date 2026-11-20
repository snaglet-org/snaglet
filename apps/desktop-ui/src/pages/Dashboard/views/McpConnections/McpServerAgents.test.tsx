import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WsMessage } from '@snaglet/shared/types';
import { WORKSPACE_EVENT_CHANNEL } from '@snaglet/shared/types/workspace-events';
import type { McpServerAgent } from '@desktop/utils/api';

const api = vi.hoisted(() => ({
  listAgents: vi.fn<(id: string) => Promise<McpServerAgent[]>>(),
  setAgents: vi.fn<(id: string, ids: string[]) => Promise<McpServerAgent[]>>(),
}));
vi.mock('@desktop/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api')>('@desktop/utils/api');
  return { ...actual, mcpServersApi: { ...actual.mcpServersApi, ...api } };
});

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);

const ws = vi.hoisted(() => ({ handlers: new Set<(m: WsMessage) => void>() }));
vi.mock('@desktop/ws/useWs', () => ({
  useWs: () => ({
    addMessageListener: (handler: (m: WsMessage) => void) => {
      ws.handlers.add(handler);
      return () => ws.handlers.delete(handler);
    },
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    connectionState: 'open',
  }),
}));

import { McpServerAgents } from './McpServerAgents';

const roster = (enabled: Record<string, boolean>): McpServerAgent[] =>
  Object.entries(enabled).map(([name, on]) => ({ id: `agent-${name}`, name, enabled: on }));

const setReturns = () =>
  api.setAgents.mockImplementation(async (_id, ids) =>
    ['a', 'b', 'c'].map((name) => ({
      id: `agent-${name}`,
      name,
      enabled: ids.includes(`agent-${name}`),
    }))
  );

describe('McpServerAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ws.handlers.clear();
    api.listAgents.mockResolvedValue(roster({ a: true, b: false, c: false }));
    setReturns();
  });

  it('shows who can use the server and enables it for every agent with an Undo', async () => {
    const user = userEvent.setup();
    render(<McpServerAgents serverId="mcp-test" serverName="Test server" />);
    expect(await screen.findByText('1 of 3 agents can use it')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Enable for all' }));
    expect(api.setAgents).toHaveBeenCalledWith('mcp-test', ['agent-a', 'agent-b', 'agent-c']);
    expect(await screen.findByText('3 of 3 agents can use it')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable for all' })).toBeDisabled();

    // The toast's Undo puts back the set from before.
    const [message, opts] = toast.showToast.mock.calls[0] as [
      string,
      { action: { run: () => void } },
    ];
    expect(message).toBe('Test server is on for every agent');
    opts.action.run();
    await waitFor(() => expect(api.setAgents).toHaveBeenLastCalledWith('mcp-test', ['agent-a']));
    expect(await screen.findByText('1 of 3 agents can use it')).toBeInTheDocument();
  });

  it('turns it off for everyone and toggles one agent without a toast', async () => {
    const user = userEvent.setup();
    render(<McpServerAgents serverId="mcp-test" serverName="Test server" />);
    await screen.findByText('1 of 3 agents can use it');

    await user.click(screen.getByRole('checkbox', { name: 'b' }));
    expect(api.setAgents).toHaveBeenLastCalledWith('mcp-test', ['agent-a', 'agent-b']);
    expect(toast.showToast).not.toHaveBeenCalled();
    await screen.findByText('2 of 3 agents can use it');

    await user.click(screen.getByRole('button', { name: 'Turn off for all' }));
    expect(api.setAgents).toHaveBeenLastCalledWith('mcp-test', []);
    expect(await screen.findByText('0 of 3 agents can use it')).toBeInTheDocument();
    expect(toast.showToast).toHaveBeenCalledWith(
      'Test server is off for every agent',
      expect.anything()
    );
  });

  it('reloads when an agent’s MCP servers change elsewhere', async () => {
    render(<McpServerAgents serverId="mcp-test" serverName="Test server" />);
    await screen.findByText('1 of 3 agents can use it');
    api.listAgents.mockResolvedValue(roster({ a: true, b: true, c: false }));
    for (const handler of ws.handlers)
      handler({
        channel: WORKSPACE_EVENT_CHANNEL,
        payload: {
          type: 'agent.updated',
          agentId: 'agent-b',
          changed: ['mcpServers'],
          ts: new Date().toISOString(),
          actor: { actorKind: 'user', actorId: 'user-test' },
        },
      } as WsMessage);
    expect(await screen.findByText('2 of 3 agents can use it')).toBeInTheDocument();
  });

  it('shows the error and reloads when a save fails', async () => {
    const user = userEvent.setup();
    api.setAgents.mockRejectedValueOnce(new Error('Server not found'));
    render(<McpServerAgents serverId="mcp-test" serverName="Test server" />);
    await screen.findByText('1 of 3 agents can use it');
    await user.click(screen.getByRole('button', { name: 'Enable for all' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Server not found');
    await screen.findByText('1 of 3 agents can use it');
  });
});
