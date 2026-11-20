import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { McpApiKey, McpServer } from '@desktop/utils/api';
import type { McpConnectionsContextValue } from '../views/McpConnections/McpConnectionsContext';

const context = vi.hoisted(() => ({ current: null as McpConnectionsContextValue | null }));

vi.mock('../views/McpConnections', () => ({
  useMcpConnections: () => context.current,
}));

import { McpConnectionsView } from './McpConnectionsView';

const client: McpApiKey = {
  id: 'client-1',
  memberId: 'member-1',
  name: 'Claude Code',
  createdAt: '2026-07-29T12:00:00.000Z',
  lastUsedAt: null,
};

const server = {
  id: 'github',
  name: 'GitHub',
  enabled: true,
  status: 'connected',
} as McpServer;

function makeContext(): McpConnectionsContextValue {
  return {
    clients: {
      keys: [client],
      loading: false,
      error: null,
      busyId: null,
      mintedToken: null,
      setError: vi.fn(),
      dismissToken: vi.fn(),
      reload: vi.fn(),
      mint: vi.fn(),
      rename: vi.fn(),
      revoke: vi.fn(),
    },
    servers: {
      servers: [server],
      loading: false,
      error: null,
      busyId: null,
      testResults: {},
      testingId: null,
      updatingId: null,
      setError: vi.fn(),
      reload: vi.fn(),
      createServer: vi.fn(),
      updateServer: vi.fn(),
      removeServer: vi.fn(),
      restoreServer: vi.fn(),
      setEnabled: vi.fn(),
      testServer: vi.fn(),
      updatePackage: vi.fn(),
      saveCredential: vi.fn(),
      deleteCredential: vi.fn(),
    },
    openServerEditor: vi.fn(),
  };
}

beforeEach(() => {
  context.current = makeContext();
});

describe('McpConnectionsView', () => {
  it('revalidates both connection lists on mount (context fetches only once at Dashboard mount)', () => {
    render(
      <McpConnectionsView onClientOpen={vi.fn()} onServerOpen={vi.fn()} activeSelectionId={null} />
    );

    // Without this, servers/keys changed out-of-band (another window, an
    // agent tool at runtime) never appear until an app restart.
    expect(context.current!.servers.reload).toHaveBeenCalled();
    expect(context.current!.clients.reload).toHaveBeenCalled();
  });

  it('renders client and server connections as separate expandable branches', () => {
    render(
      <McpConnectionsView
        onClientOpen={vi.fn()}
        onServerOpen={vi.fn()}
        activeSelectionId="server:github"
      />
    );

    expect(screen.getByRole('button', { name: /client connections/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('button', { name: /server connections/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('button', { name: /claude code/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /github/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('creates a client inline and opens its one-time-key pane', async () => {
    const user = userEvent.setup();
    const onClientOpen = vi.fn();
    vi.mocked(context.current!.clients.mint).mockResolvedValue({
      key: client,
      token: 'snaglet_mcp_secret',
    });
    render(
      <McpConnectionsView
        onClientOpen={onClientOpen}
        onServerOpen={vi.fn()}
        activeSelectionId={null}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Create MCP client connection' }));
    await user.type(screen.getByRole('textbox', { name: 'New MCP client name' }), 'Codex');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(context.current!.clients.mint).toHaveBeenCalledWith('Codex');
    expect(onClientOpen).toHaveBeenCalledWith(client);
  });

  it('labels an idle-stopped server apart from a disconnected one', () => {
    context.current!.servers.servers = [
      { ...server, id: 'github', name: 'GitHub', status: 'idle' } as McpServer,
      { ...server, id: 'firecrawl', name: 'Firecrawl', status: 'disconnected' } as McpServer,
      { ...server, id: 'notion', name: 'Notion', status: 'unknown' } as McpServer,
    ];
    render(
      <McpConnectionsView onClientOpen={vi.fn()} onServerOpen={vi.fn()} activeSelectionId={null} />
    );

    expect(screen.getByLabelText('idle (stopped)')).toHaveAttribute('data-status', 'idle');
    expect(screen.getByLabelText('disconnected')).toHaveAttribute('data-status', 'disconnected');
    expect(screen.getByLabelText('not started')).toHaveAttribute('data-status', 'unknown');
  });

  it('opens the existing server editor from the server branch add action', async () => {
    const user = userEvent.setup();
    render(
      <McpConnectionsView onClientOpen={vi.fn()} onServerOpen={vi.fn()} activeSelectionId={null} />
    );

    await user.click(screen.getByRole('button', { name: 'Connect MCP server' }));
    expect(context.current!.openServerEditor).toHaveBeenCalledWith();
  });
});
