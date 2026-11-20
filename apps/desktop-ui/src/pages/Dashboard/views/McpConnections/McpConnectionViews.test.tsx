import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { McpApiKey, McpServer } from '@desktop/utils/api';
import type { McpConnectInfo } from '@snaglet/shared/types';
import type { McpConnectionsContextValue } from './McpConnectionsContext';
import type { UseMcpConnectInfo } from './useMcpConnectInfo';

const mocks = vi.hoisted(() => ({
  context: null as McpConnectionsContextValue | null,
  connect: { info: null, error: null } as UseMcpConnectInfo,
  emit: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('./McpConnectionsContext', () => ({
  useMcpConnections: () => mocks.context,
}));
vi.mock('./useMcpConnectInfo', () => ({ useMcpConnectInfo: () => mocks.connect }));
// The Agents section has its own test (McpServerAgents.test.tsx).
vi.mock('./McpServerAgents', () => ({ McpServerAgents: () => null }));
vi.mock('@desktop/utils/mcpConnectionEvents', () => ({
  emitMcpConnectionEvent: mocks.emit,
}));
vi.mock('@desktop/utils/toast', () => ({ showToast: mocks.showToast }));

import { McpClientConnectionView } from './McpClientConnectionView';
import { McpServerConnectionView } from './McpServerConnectionView';

const client: McpApiKey = {
  id: 'client-1',
  memberId: 'member-1',
  name: 'Claude Code',
  createdAt: '2026-07-29T12:00:00.000Z',
  lastUsedAt: null,
};

const server = {
  id: 'github',
  providerId: null,
  name: 'GitHub',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  url: null,
  headers: {},
  env: {},
  scope: 'shared',
  enabled: true,
  autoload: true,
  requiresConfirmation: true,
  source: 'user',
  createdAt: '2026-07-29T12:00:00.000Z',
  updatedAt: '2026-07-29T12:00:00.000Z',
  status: 'connected',
  requiresCredential: false,
  credentialSpec: { requiresSecret: false, bundleFields: [] },
  hasCredential: false,
} satisfies McpServer;

function makeContext(): McpConnectionsContextValue {
  return {
    clients: {
      keys: [client],
      loading: false,
      error: null,
      busyId: null,
      mintedToken: { keyId: client.id, token: 'snaglet_mcp_secret' },
      setError: vi.fn(),
      dismissToken: vi.fn(),
      reload: vi.fn(),
      mint: vi.fn(),
      rename: vi.fn(async () => true),
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
      removeServer: vi.fn(async () => true),
      restoreServer: vi.fn(async () => undefined),
      setEnabled: vi.fn(),
      testServer: vi.fn(),
      updatePackage: vi.fn(),
      saveCredential: vi.fn(),
      deleteCredential: vi.fn(),
    },
    openServerEditor: vi.fn(),
  };
}

const connectInfo: McpConnectInfo = {
  snagletHome: '/Users/test-user/.snaglet',
  isDefaultHome: true,
  profile: 'production',
  cliPath: '/Users/test-user/.local/bin/snaglet',
  cliOnPath: true,
  port: 51234,
  mcpUrl: 'http://127.0.0.1:51234/mcp',
};

beforeEach(() => {
  mocks.context = makeContext();
  mocks.connect = { info: connectInfo, error: null };
  mocks.emit.mockReset();
  mocks.showToast.mockReset();
});

/** The [message, options] of the one toast shown so far. */
function shownToast(): [string, { action?: { label: string; run: () => void } }] {
  expect(mocks.showToast).toHaveBeenCalledTimes(1);
  return mocks.showToast.mock.calls[0] as [string, { action?: { label: string; run: () => void } }];
}

describe('MCP connection panes', () => {
  it('revalidates its list on mount (context fetches only once at Dashboard mount)', () => {
    render(<McpClientConnectionView clientId={client.id} />);
    expect(mocks.context!.clients.reload).toHaveBeenCalled();

    render(<McpServerConnectionView serverId={server.id} />);
    expect(mocks.context!.servers.reload).toHaveBeenCalled();
  });

  it('reveals a newly minted client key and supports double-click rename', async () => {
    const user = userEvent.setup();
    const clipboardSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<McpClientConnectionView clientId={client.id} />);

    expect(screen.getByText('snaglet_mcp_secret')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy key' }));
    expect(clipboardSpy).toHaveBeenCalledWith('snaglet_mcp_secret');

    fireEvent.doubleClick(screen.getByRole('heading', { name: 'Claude Code' }));
    const nameInput = screen.getByRole('textbox', { name: 'Client connection name' });
    await user.clear(nameInput);
    await user.type(nameInput, 'Codex');
    fireEvent.blur(nameInput);

    await waitFor(() => {
      expect(mocks.context!.clients.rename).toHaveBeenCalledWith(client.id, 'Codex');
      expect(mocks.emit).toHaveBeenCalledWith({
        type: 'client-renamed',
        id: client.id,
        name: 'Codex',
      });
    });
  });

  it('says so when the one-time client key cannot be copied', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('clipboard denied'));
    render(<McpClientConnectionView clientId={client.id} />);

    await user.click(screen.getByRole('button', { name: 'Copy key' }));

    expect(mocks.context!.clients.setError).toHaveBeenCalledWith('clipboard denied');
    expect(screen.getByRole('button', { name: 'Copy key' })).toBeInTheDocument();
  });

  it('starts a rename from the keyboard', async () => {
    const user = userEvent.setup();
    render(<McpClientConnectionView clientId={client.id} />);

    screen.getByRole('heading', { name: 'Claude Code' }).focus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('textbox', { name: 'Client connection name' })).toHaveFocus();
  });

  it('reopens the existing server modal from a server connection tab', async () => {
    const user = userEvent.setup();
    render(<McpServerConnectionView serverId={server.id} />);

    await user.click(screen.getByRole('button', { name: 'Edit connection' }));
    expect(mocks.context!.openServerEditor).toHaveBeenCalledWith(server);
  });

  it('revokes a client connection only after the in-app confirmation', async () => {
    const user = userEvent.setup();
    render(<McpClientConnectionView clientId={client.id} />);

    await user.click(screen.getByRole('button', { name: 'Revoke connection' }));
    expect(mocks.context!.clients.revoke).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', {
      name: 'Revoke the MCP client connection “Claude Code”?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(mocks.context!.clients.revoke).toHaveBeenCalledWith(client.id));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('canceling the revoke confirmation leaves the client untouched', async () => {
    const user = userEvent.setup();
    render(<McpClientConnectionView clientId={client.id} />);

    await user.click(screen.getByRole('button', { name: 'Revoke connection' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Revoke the MCP client connection “Claude Code”?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(mocks.context!.clients.revoke).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('deletes a server connection at once, with no confirmation, and offers Undo', async () => {
    const user = userEvent.setup();
    render(<McpServerConnectionView serverId={server.id} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.context!.servers.removeServer).toHaveBeenCalledWith(server.id);
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());
    const [message, opts] = shownToast();
    expect(message).toBe('Deleted GitHub');
    expect(opts.action?.label).toBe('Undo');
    expect(mocks.context!.servers.restoreServer).not.toHaveBeenCalled();
  });

  it('Undo restores the deleted server by id only', async () => {
    const user = userEvent.setup();
    render(<McpServerConnectionView serverId={server.id} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());

    shownToast()[1].action?.run();

    // Only the id goes back: the server holds the config, secrets included.
    expect(mocks.context!.servers.restoreServer).toHaveBeenCalledWith(server.id);
    expect(mocks.context!.servers.createServer).not.toHaveBeenCalled();
  });

  it('says so in a toast when Undo fails', async () => {
    const user = userEvent.setup();
    vi.mocked(mocks.context!.servers.restoreServer).mockRejectedValueOnce(
      new Error("Server 'github' can no longer be restored: its undo window has passed.")
    );
    render(<McpServerConnectionView serverId={server.id} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());

    shownToast()[1].action?.run();

    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenLastCalledWith(
        "Server 'github' can no longer be restored: its undo window has passed."
      )
    );
  });

  it('shows the installed version of an npx server and updates it from the pane', async () => {
    const user = userEvent.setup();
    const installed = {
      ...server,
      install: {
        state: 'installed' as const,
        packageName: '@modelcontextprotocol/server-github',
        requested: null,
        installedVersion: '2025.4.8',
        installedAt: '2026-07-29T12:00:00.000Z',
        reason: null,
        lastError: null,
        updatable: true,
      },
    };
    mocks.context!.servers.servers = [installed];
    vi.mocked(mocks.context!.servers.updatePackage).mockResolvedValueOnce({
      ok: true,
      previousVersion: '2025.4.8',
      installedVersion: '2025.9.1',
      restarted: true,
      server: installed,
    });
    render(<McpServerConnectionView serverId={server.id} />);

    expect(screen.getByText('Installed 2025.4.8')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update' }));

    expect(mocks.context!.servers.updatePackage).toHaveBeenCalledWith(server.id);
    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith('Updated GitHub to 2025.9.1 and restarted it')
    );
  });

  it('says in a toast when Update fails', async () => {
    const user = userEvent.setup();
    mocks.context!.servers.servers = [
      {
        ...server,
        install: {
          state: 'npx',
          packageName: '@modelcontextprotocol/server-github',
          requested: null,
          installedVersion: null,
          installedAt: null,
          reason: "npm wasn't found on PATH",
          lastError: "npm wasn't found on PATH",
          updatable: true,
        },
      },
    ];
    vi.mocked(mocks.context!.servers.updatePackage).mockResolvedValueOnce({
      ok: false,
      previousVersion: null,
      installedVersion: null,
      restarted: false,
      error: "npm wasn't found on PATH",
      server,
    });
    render(<McpServerConnectionView serverId={server.id} />);

    expect(screen.getByText("Runs through npx: npm wasn't found on PATH")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith(
        "Couldn't update GitHub: npm wasn't found on PATH",
        { durationMs: 6000 }
      )
    );
  });

  it('offers no Update for a command Snaglet cannot install', () => {
    mocks.context!.servers.servers = [
      {
        ...server,
        args: ['-y', 'github:example/server'],
        install: {
          state: 'npx',
          packageName: null,
          requested: null,
          installedVersion: null,
          installedAt: null,
          reason: 'unsupported package spec',
          lastError: null,
          updatable: false,
        },
      },
    ];
    render(<McpServerConnectionView serverId={server.id} />);

    expect(screen.getByText('Runs through npx: unsupported package spec')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
  });

  it('shows a server the idle reaper stopped as idle, not as an error', () => {
    mocks.context!.servers.servers = [{ ...server, status: 'idle', statusDetail: null }];
    render(<McpServerConnectionView serverId={server.id} />);

    expect(screen.getByText('Idle (stopped)')).toBeInTheDocument();
    expect(screen.queryByText('Disconnected')).not.toBeInTheDocument();
    expect(screen.queryByText('Last error')).not.toBeInTheDocument();
  });

  it('shows why a disconnected server failed to start', () => {
    mocks.context!.servers.servers = [
      { ...server, status: 'disconnected', statusDetail: "Command 'npx' was not found on PATH." },
    ];
    render(<McpServerConnectionView serverId={server.id} />);

    expect(screen.getByText('Disconnected')).toBeInTheDocument();
    expect(screen.getByText('Last error')).toBeInTheDocument();
    expect(screen.getByText("Command 'npx' was not found on PATH.")).toBeInTheDocument();
  });

  it('offers no Undo when the delete failed', async () => {
    const user = userEvent.setup();
    vi.mocked(mocks.context!.servers.removeServer).mockResolvedValueOnce(false);
    render(<McpServerConnectionView serverId={server.id} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(mocks.context!.servers.removeServer).toHaveBeenCalledWith(server.id)
    );
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  describe('Connect setup', () => {
    const TOKEN = 'snaglet_mcp_secret';

    it('the one-time view shows the setup with the key filled in, each with Copy', async () => {
      const user = userEvent.setup();
      const clipboardSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
      render(<McpClientConnectionView clientId={client.id} />);

      expect(screen.getByText(/This key is for the/)).toHaveTextContent(
        'This key is for the production Snaglet at /Users/test-user/.snaglet.'
      );
      const command = `claude mcp add snaglet --env SNAGLET_MCP_KEY=${TOKEN} -- snaglet mcp`;
      expect(screen.getByText(command)).toBeInTheDocument();
      expect(screen.getByText('http://127.0.0.1:51234/mcp')).toBeInTheDocument();
      expect(screen.getByText(`Authorization: Bearer ${TOKEN}`)).toBeInTheDocument();
      expect(screen.getByText(/"SNAGLET_MCP_KEY": "snaglet_mcp_secret"/)).toBeInTheDocument();
      expect(screen.queryByText(/shown only once, when this connection was created/)).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Copy Claude Code command' }));
      expect(clipboardSpy).toHaveBeenCalledWith(command);
      await user.click(screen.getByRole('button', { name: 'Copy MCP JSON config' }));
      expect(
        JSON.parse(clipboardSpy.mock.calls[clipboardSpy.mock.calls.length - 1]![0] as string)
      ).toEqual({
        mcpServers: {
          snaglet: { command: 'snaglet', args: ['mcp'], env: { SNAGLET_MCP_KEY: TOKEN } },
        },
      });
      for (const label of ['HTTP URL', 'HTTP header'])
        expect(screen.getByRole('button', { name: `Copy ${label}` })).toBeInTheDocument();
    });

    it('after the key is hidden: the placeholder setup, the shown-once line, and no key in the DOM', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<McpClientConnectionView clientId={client.id} />);
      expect(document.body.innerHTML).toContain(TOKEN);

      vi.mocked(mocks.context!.clients.dismissToken).mockImplementation(() => {
        mocks.context = {
          ...mocks.context!,
          clients: { ...mocks.context!.clients, mintedToken: null },
        };
      });
      await user.click(screen.getByRole('button', { name: 'Hide key' }));
      rerender(<McpClientConnectionView clientId={client.id} />);

      expect(document.body.innerHTML).not.toContain(TOKEN);
      expect(
        screen.getByText('claude mcp add snaglet --env SNAGLET_MCP_KEY=<your key> -- snaglet mcp')
      ).toBeInTheDocument();
      expect(screen.getByText('Authorization: Bearer <your key>')).toBeInTheDocument();
      expect(
        screen.getByText(/shown only once, when this connection was created/)
      ).toBeInTheDocument();
    });

    it('a dev Snaglet: labeled dev, with SNAGLET_HOME and the absolute CLI path', () => {
      mocks.connect = {
        info: {
          ...connectInfo,
          snagletHome: '/Users/test-user/.snaglet-dev',
          isDefaultHome: false,
          profile: 'dev',
          cliOnPath: false,
          cliPath: '/Users/test-user/code/snaglet/packages/snaglet-cli/bin/snaglet.mjs',
          port: 4001,
          mcpUrl: 'http://127.0.0.1:4001/mcp',
        },
        error: null,
      };
      mocks.context!.clients.mintedToken = null;
      render(<McpClientConnectionView clientId={client.id} />);
      expect(screen.getByText(/This key is for the/)).toHaveTextContent(
        'This key is for the dev Snaglet at /Users/test-user/.snaglet-dev.'
      );
      expect(
        screen.getByText(
          'claude mcp add snaglet-dev --env SNAGLET_MCP_KEY=<your key> --env SNAGLET_HOME=/Users/test-user/.snaglet-dev -- /Users/test-user/code/snaglet/packages/snaglet-cli/bin/snaglet.mjs mcp'
        )
      ).toBeInTheDocument();
    });

    it('says how to get the CLI when the server found none', () => {
      mocks.connect = { info: { ...connectInfo, cliOnPath: false, cliPath: null }, error: null };
      render(<McpClientConnectionView clientId={client.id} />);
      expect(screen.getByText(/No/, { selector: 'p' })).toHaveTextContent('on your PATH');
    });

    it('shows the error when the connection details cannot load', () => {
      mocks.connect = { info: null, error: 'Could not load the connection details.' };
      render(<McpClientConnectionView clientId={client.id} />);
      expect(screen.getByText('Could not load the connection details.')).toBeInTheDocument();
    });

    it('a failed copy says so', async () => {
      const user = userEvent.setup();
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
      render(<McpClientConnectionView clientId={client.id} />);
      await user.click(screen.getByRole('button', { name: 'Copy HTTP URL' }));
      await waitFor(() =>
        expect(mocks.context!.clients.setError).toHaveBeenCalledWith(
          'Could not copy to the clipboard. Select the text and copy it by hand.'
        )
      );
    });
  });
});
