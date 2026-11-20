import { useEffect, useState, type FC, type KeyboardEvent, type MouseEvent } from 'react';
import { Tree, TreeGroup, TreeRow } from '@desktop/components/SidebarTree';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
import type { McpApiKey, McpServer } from '@desktop/utils/api';
import { useMcpConnections } from '../views/McpConnections';
import { SidebarView } from './SidebarView';
import styles from './McpConnectionsView.module.scss';

interface McpConnectionsViewProps {
  onClientOpen: (client: McpApiKey) => void;
  onServerOpen: (server: McpServer) => void;
  activeSelectionId?: string | null;
}

function stopGroupToggle(event: MouseEvent<HTMLButtonElement>): void {
  event.stopPropagation();
}

const STATUS_TEXT: Record<McpServer['status'], string> = {
  connected: 'connected',
  connecting: 'connecting',
  disconnected: 'disconnected',
  idle: 'idle (stopped)',
  unknown: 'not started',
};

/** The sidebar's one-word state: disabled, or the live status. */
function serverStateText(server: McpServer): string {
  return server.enabled ? STATUS_TEXT[server.status] : 'disabled';
}

export const McpConnectionsView: FC<McpConnectionsViewProps> = ({
  onClientOpen,
  onServerOpen,
  activeSelectionId = null,
}) => {
  const { clients, servers, openServerEditor } = useMcpConnections();

  // Stale-while-revalidate: the context fetches once at Dashboard mount, so
  // opening this view revalidates both lists — changes made out-of-band
  // (another window, an agent tool at runtime) appear on visit instead of
  // after an app restart. Depend on the stable reload callbacks, NOT the
  // context objects (those change identity on every provider state update,
  // which would loop reload -> state -> reload).
  const reloadServers = servers.reload;
  const reloadClients = clients.reload;
  useEffect(() => {
    void reloadServers();
    void reloadClients();
  }, [reloadServers, reloadClients]);

  const [clientsOpen, setClientsOpen] = useState(true);
  const [serversOpen, setServersOpen] = useState(true);
  const [creatingClient, setCreatingClient] = useState(false);
  const [clientName, setClientName] = useState('');

  const cancelClientCreate = () => {
    setClientName('');
    setCreatingClient(false);
  };

  const beginClientCreate = () => {
    setClientsOpen(true);
    setCreatingClient(true);
  };

  const createClient = async () => {
    const name = clientName.trim();
    if (!name) return;
    const minted = await clients.mint(name);
    if (!minted) return;
    setClientName('');
    setCreatingClient(false);
    onClientOpen(minted.key);
  };

  const beginServerCreate = () => {
    setServersOpen(true);
    openServerEditor();
  };

  return (
    <SidebarView title="MCP">
      <Tree aria-label="MCP connections">
        <TreeGroup
          label="Client connections"
          count={clients.keys.length}
          open={clientsOpen}
          onToggle={() => setClientsOpen((open) => !open)}
          trailing={
            <button
              type="button"
              className={styles.addButton}
              onClick={(event) => {
                stopGroupToggle(event);
                beginClientCreate();
              }}
              onKeyDown={(event) => event.stopPropagation()}
              aria-label="Create MCP client connection"
              title="Create client connection"
            >
              +
            </button>
          }
        >
          {creatingClient && (
            <form
              className={styles.createRow}
              onSubmit={(event) => {
                event.preventDefault();
                void createClient();
              }}
            >
              <input
                autoFocus
                className={styles.createInput}
                value={clientName}
                onChange={(event) => setClientName(event.target.value)}
                onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  if (event.key === 'Escape') cancelClientCreate();
                }}
                placeholder="Client name"
                aria-label="New MCP client name"
              />
              <button
                type="submit"
                className={styles.createAction}
                disabled={!clientName.trim() || clients.busyId === 'mint'}
              >
                {clients.busyId === 'mint' ? '…' : 'Create'}
              </button>
              <button
                type="button"
                className={styles.cancelAction}
                onClick={cancelClientCreate}
                aria-label="Cancel client connection creation"
              >
                ×
              </button>
            </form>
          )}
          {clients.error && (
            <div className={styles.connectionError} role="alert">
              <span>{clients.error}</span>
              <button type="button" onClick={() => clients.setError(null)}>
                Dismiss
              </button>
            </div>
          )}

          {clients.loading ? (
            <StateHint>Loading client connections…</StateHint>
          ) : clients.keys.length === 0 && !creatingClient ? (
            <div className={styles.emptyHint}>Use + to create a client key.</div>
          ) : (
            clients.keys.map((client) => (
              <TreeRow
                key={client.id}
                depth={1}
                chevron="empty"
                icon={<span className={styles.inboundIcon}>⇢</span>}
                label={client.name}
                description={client.lastUsedAt ? 'used' : 'new'}
                active={activeSelectionId === `client:${client.id}`}
                aria-selected={activeSelectionId === `client:${client.id}`}
                paneSelection={{
                  kind: 'mcp-client-connection',
                  client_id: client.id,
                  name: client.name,
                }}
                onClick={() => onClientOpen(client)}
                title={`${client.name} — external client connecting into Snaglet`}
              />
            ))
          )}
        </TreeGroup>

        <TreeGroup
          label="Server connections"
          count={servers.servers.length}
          open={serversOpen}
          onToggle={() => setServersOpen((open) => !open)}
          trailing={
            <button
              type="button"
              className={styles.addButton}
              onClick={(event) => {
                stopGroupToggle(event);
                beginServerCreate();
              }}
              onKeyDown={(event) => event.stopPropagation()}
              aria-label="Connect MCP server"
              title="Connect server"
            >
              +
            </button>
          }
        >
          {servers.error && (
            <div className={styles.connectionError} role="alert">
              <span>{servers.error}</span>
              <button type="button" onClick={() => servers.setError(null)}>
                Dismiss
              </button>
            </div>
          )}
          {servers.loading ? (
            <StateHint>Loading server connections…</StateHint>
          ) : servers.servers.length === 0 ? (
            <div className={styles.emptyHint}>Use + to connect an MCP server.</div>
          ) : (
            servers.servers.map((server) => (
              <TreeRow
                key={server.id}
                depth={1}
                chevron="empty"
                icon={<span className={styles.outboundIcon}>⇠</span>}
                label={server.name}
                description={serverStateText(server)}
                active={activeSelectionId === `server:${server.id}`}
                aria-selected={activeSelectionId === `server:${server.id}`}
                paneSelection={{
                  kind: 'mcp-server-connection',
                  server_id: server.id,
                  name: server.name,
                }}
                trailing={
                  <span
                    className={styles.statusDot}
                    data-status={server.enabled ? server.status : 'disabled'}
                    aria-label={serverStateText(server)}
                  />
                }
                onClick={() => onServerOpen(server)}
                title={`${server.name} — Snaglet connecting to this MCP server`}
              />
            ))
          )}
        </TreeGroup>
      </Tree>
    </SidebarView>
  );
};
