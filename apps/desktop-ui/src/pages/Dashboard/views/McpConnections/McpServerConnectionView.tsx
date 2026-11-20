import { useEffect, type FC } from 'react';
import { Button, EmptyState } from '@desktop/components';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
import { showToast } from '@desktop/utils/toast';
import { getErrorMessage } from '@snaglet/shared/utils';
import { ServerRow } from '../McpView/ServerRow';
import { useMcpConnections } from './McpConnectionsContext';
import { McpServerAgents } from './McpServerAgents';
import styles from './McpConnections.module.scss';

export const McpServerConnectionView: FC<{ serverId: string }> = ({ serverId }) => {
  const { servers, openServerEditor } = useMcpConnections();

  // Stale-while-revalidate: the context fetched once at Dashboard mount;
  // visiting this pane refetches so out-of-band changes (another window, an
  // agent tool) show up. Depends on the stable reload callback, not the
  // context object, to avoid a reload -> state -> reload loop.
  const reloadServers = servers.reload;
  useEffect(() => {
    void reloadServers();
  }, [reloadServers]);

  const server = servers.servers.find((item) => item.id === serverId);

  // No confirmation: Delete happens at once and the toast offers Undo. The
  // server keeps the deleted config, so undo sends only the id (env and
  // headers can hold secrets).
  const remove = async (id: string, name: string) => {
    if (!(await servers.removeServer(id))) return;
    showToast(`Deleted ${name}`, {
      action: {
        label: 'Undo',
        run: () => {
          void servers
            .restoreServer(id)
            .catch((err: unknown) => showToast(getErrorMessage(err, "Couldn't undo")));
        },
      },
    });
  };

  // Update reinstalls the server's npx package; the toast says what changed.
  const updatePackage = async (id: string, name: string) => {
    try {
      const result = await servers.updatePackage(id);
      if (!result.ok) {
        showToast(`Couldn't update ${name}: ${result.error ?? 'the install failed'}`, {
          durationMs: 6000,
        });
        return;
      }
      if (result.error) {
        showToast(result.error, { durationMs: 6000 });
        return;
      }
      const version = result.installedVersion ?? '';
      const restarted = result.restarted ? ' and restarted it' : '';
      showToast(
        result.previousVersion === result.installedVersion
          ? `${name} is up to date (${version}); reinstalled${restarted}`
          : `Updated ${name} to ${version}${restarted}`
      );
    } catch (err: unknown) {
      showToast(getErrorMessage(err, `Couldn't update ${name}`), { durationMs: 6000 });
    }
  };

  if (servers.loading) {
    return (
      <div className={styles.shell}>
        <StateHint>Loading server connection…</StateHint>
      </div>
    );
  }

  if (!server) {
    return (
      <EmptyState
        title="Server connection unavailable"
        body="It may have been deleted. Select another connection from the MCP sidebar."
      />
    );
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerActions}>
          <div>
            <div className={styles.flowLabel}>
              <span>Snaglet</span>
              <span className={styles.flowArrow} aria-hidden>
                ⇢
              </span>
              <span aria-hidden>SERVER</span>
            </div>
            <h1 className={styles.title}>{server.name}</h1>
          </div>
          <Button variant="primary" size="sm" onClick={() => openServerEditor(server)}>
            Edit connection
          </Button>
        </div>
        <p className={styles.subtitle}>
          Snaglet connects outward to this MCP server and makes its discovered tools available to
          enabled agents.
        </p>
      </header>

      <div className={styles.body}>
        {servers.error && (
          <div className={styles.errorBanner} role="alert">
            {servers.error}
            <Button variant="ghost" size="xs" onClick={() => servers.setError(null)}>
              Dismiss
            </Button>
          </div>
        )}
        <ServerRow
          server={server}
          busy={servers.busyId === server.id}
          testing={servers.testingId === server.id}
          testResult={servers.testResults[server.id]}
          initiallyExpanded
          onEdit={() => openServerEditor(server)}
          onToggleEnabled={(enabled) => void servers.setEnabled(server.id, enabled)}
          onTest={() => void servers.testServer(server.id)}
          onRemove={() => void remove(server.id, server.name)}
          updating={servers.updatingId === server.id}
          onUpdatePackage={() => void updatePackage(server.id, server.name)}
          onSaveCredential={(body) => servers.saveCredential(server.id, body)}
          onDeleteCredential={() => void servers.deleteCredential(server.id)}
        />
        <McpServerAgents serverId={server.id} serverName={server.name} />
      </div>
    </div>
  );
};
