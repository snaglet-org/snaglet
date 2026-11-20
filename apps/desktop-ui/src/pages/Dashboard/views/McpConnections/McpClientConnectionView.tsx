import { useEffect, useState, type FC, type KeyboardEvent } from 'react';
import { Button, EmptyState, TextInput } from '@desktop/components';
import { ConfirmModal } from '@desktop/components/Modal';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
import { emitMcpConnectionEvent } from '@desktop/utils/mcpConnectionEvents';
import { getErrorMessage } from '@snaglet/shared/utils';
import { McpConnectSetup } from './McpConnectSetup';
import { useMcpConnections } from './McpConnectionsContext';
import { useMcpConnectInfo } from './useMcpConnectInfo';
import styles from './McpConnections.module.scss';

/** How long Copy key reads "Copied". */
const COPIED_NOTICE_MS = 1500;

function formatDate(iso: string | null): string {
  if (!iso) return 'Never';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

export const McpClientConnectionView: FC<{ clientId: string }> = ({ clientId }) => {
  const { clients } = useMcpConnections();
  const connect = useMcpConnectInfo();

  // Stale-while-revalidate: the context fetched once at Dashboard mount;
  // visiting this pane refetches so out-of-band key changes show up. Depends
  // on the stable reload callback, not the context object, to avoid a
  // reload -> state -> reload loop.
  const reloadClients = clients.reload;
  useEffect(() => {
    void reloadClients();
  }, [reloadClients]);

  const client = clients.keys.find((key) => key.id === clientId);
  const revealedToken = clients.mintedToken?.keyId === clientId ? clients.mintedToken.token : null;
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(client?.name ?? '');
  const [copied, setCopied] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  useEffect(() => {
    if (!editingName) setNameDraft(client?.name ?? '');
  }, [client?.name, editingName]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (clients.loading) {
    return (
      <div className={styles.shell}>
        <StateHint>Loading client connection…</StateHint>
      </div>
    );
  }

  if (!client) {
    return (
      <EmptyState
        title="Client connection unavailable"
        body="This key may have been revoked. Select another connection from the MCP sidebar."
      />
    );
  }

  const commitName = async () => {
    const name = nameDraft.trim();
    setEditingName(false);
    if (!name || name === client.name) {
      setNameDraft(client.name);
      return;
    }
    if (await clients.rename(client.id, name)) {
      emitMcpConnectionEvent({ type: 'client-renamed', id: client.id, name });
    } else {
      setNameDraft(client.name);
    }
  };

  const onNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') {
      setNameDraft(client.name);
      setEditingName(false);
    }
  };

  const copyToken = async () => {
    if (!revealedToken) return;
    try {
      await navigator.clipboard.writeText(revealedToken);
      setCopied(true);
    } catch (err) {
      // The key is shown only once, so a failed copy must not pass silently.
      setCopied(false);
      clients.setError(
        getErrorMessage(err, 'Could not copy the key. Select it and copy it by hand.')
      );
    }
  };

  // Runs only from the ConfirmModal's confirm button (window.confirm is
  // suppressed by the Tauri webview — a native gate here dies silently).
  const revoke = async () => {
    await clients.revoke(client.id);
  };

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.flowLabel}>
          <span aria-hidden>CLIENT</span>
          <span className={styles.flowArrow} aria-hidden>
            ⇢
          </span>
          <span>Snaglet</span>
        </div>
        {editingName ? (
          <TextInput
            autoFocus
            fullWidth
            className={styles.titleInput}
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={onNameKeyDown}
            aria-label="Client connection name"
          />
        ) : (
          // Focusable so keyboard users can rename too (Enter or F2).
          <h1
            className={styles.title}
            tabIndex={0}
            onDoubleClick={() => setEditingName(true)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== 'F2') return;
              event.preventDefault();
              setEditingName(true);
            }}
            title="Double-click or press Enter to rename"
          >
            {client.name}
          </h1>
        )}
        <p className={styles.subtitle}>
          This external client enters Snaglet through <code>/mcp</code>. Its work is attributed to a
          dedicated workspace member.
        </p>
      </header>

      <div className={styles.body}>
        {clients.error && (
          <div className={styles.errorBanner} role="alert">
            {clients.error}
            <Button variant="ghost" size="xs" onClick={() => clients.setError(null)}>
              Dismiss
            </Button>
          </div>
        )}

        <section className={styles.section}>
          <div className={styles.sectionHeading}>Connection key</div>
          {revealedToken ? (
            <div className={styles.tokenReveal}>
              <div className={styles.tokenNotice}>
                Copy this key now. Snaglet stores only its hash and cannot show it again.
              </div>
              <code className={styles.tokenValue}>{revealedToken}</code>
              <div className={styles.actions}>
                <Button variant="primary" size="sm" onClick={() => void copyToken()}>
                  {copied ? 'Copied' : 'Copy key'}
                </Button>
                <Button variant="ghost" size="sm" onClick={clients.dismissToken}>
                  Hide key
                </Button>
              </div>
            </div>
          ) : (
            <div className={styles.keyUnavailable}>
              The key is hidden after creation. If it was lost, revoke this connection and create a
              replacement.
            </div>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}>Connect</div>
          {connect.info ? (
            <McpConnectSetup
              info={connect.info}
              token={revealedToken}
              onCopyError={() =>
                clients.setError(
                  'Could not copy to the clipboard. Select the text and copy it by hand.'
                )
              }
            />
          ) : (
            <div className={styles.keyUnavailable}>
              {connect.error ?? 'Loading connection details…'}
            </div>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}>Activity</div>
          <dl className={styles.detailGrid}>
            <dt>Created</dt>
            <dd>{formatDate(client.createdAt)}</dd>
            <dt>Last used</dt>
            <dd>{formatDate(client.lastUsedAt)}</dd>
            <dt>Connection ID</dt>
            <dd>
              <code>{client.id}</code>
            </dd>
          </dl>
        </section>

        <div className={styles.dangerRow}>
          <Button
            variant="danger"
            size="sm"
            disabled={clients.busyId === client.id}
            onClick={() => setConfirmingRevoke(true)}
          >
            {clients.busyId === client.id ? 'Revoking…' : 'Revoke connection'}
          </Button>
        </div>
      </div>
      {confirmingRevoke && (
        <ConfirmModal
          title={`Revoke the MCP client connection “${client.name}”?`}
          confirmLabel="Revoke"
          destructive
          onConfirm={() => {
            // Close first — the button's own busyId text and the context's
            // error banner carry the in-flight and failure states.
            setConfirmingRevoke(false);
            void revoke();
          }}
          onCancel={() => setConfirmingRevoke(false)}
        >
          The client loses access immediately and the key cannot be restored.
        </ConfirmModal>
      )}
    </div>
  );
};
