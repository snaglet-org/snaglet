import { useState, type FC } from 'react';
import { Button, TextInput, Textarea, Switch, Chip } from '@desktop/components';
import type {
  McpServer,
  McpTestResult,
  McpCredentialInput,
  McpInstallInfo,
} from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import styles from './McpView.module.scss';

interface ServerRowProps {
  server: McpServer;
  busy: boolean;
  testing: boolean;
  testResult?: McpTestResult;
  onEdit: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onTest: () => void;
  onRemove: () => void;
  onSaveCredential: (body: McpCredentialInput) => Promise<boolean>;
  onDeleteCredential: () => void;
  /** Update an npx server's installed package; omitted where the row offers no Update. */
  onUpdatePackage?: () => void;
  updating?: boolean;
  initiallyExpanded?: boolean;
}

const STATUS_LABEL: Record<McpServer['status'], string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  idle: 'Idle (stopped)',
  unknown: 'Not started',
};

const STATUS_TITLE: Partial<Record<McpServer['status'], string>> = {
  idle: 'Stopped after 10 minutes without a tool call. Its tools stay available; the next call starts it.',
  unknown: 'Starts when an agent that has it enabled needs it.',
};

/** The install line for an `npx <pkg>` server. */
function installLine(install: McpInstallInfo): string {
  switch (install.state) {
    case 'installed':
      return `Installed ${install.installedVersion ?? ''}`.trim();
    case 'installing':
      return 'Installing…';
    case 'pending':
      return install.reason
        ? `Installs on next start (${install.reason})`
        : 'Installs on first start';
    case 'npx':
      return `Runs through npx: ${install.reason ?? 'unknown reason'}`;
  }
}

function installTitle(install: McpInstallInfo): string | undefined {
  if (install.state !== 'installed' || !install.installedAt) return undefined;
  const pinned = install.requested ? `, pinned to ${install.requested}` : '';
  return `${install.packageName ?? 'Package'} installed ${new Date(install.installedAt).toLocaleString()}${pinned}`;
}

/** One MCP server in the list: summary line + expandable config/credential panel. */
export const ServerRow: FC<ServerRowProps> = ({
  server,
  busy,
  testing,
  testResult,
  onEdit,
  onToggleEnabled,
  onTest,
  onRemove,
  onSaveCredential,
  onDeleteCredential,
  onUpdatePackage,
  updating = false,
  initiallyExpanded = false,
}) => {
  const { install } = server;
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const { credentialSpec } = server;
  const hasBundle = credentialSpec.bundleFields.length > 0;

  // Credential draft (kept local — never preloaded with secrets).
  const [secret, setSecret] = useState('');
  const [bundle, setBundle] = useState<Record<string, string>>({});
  const [pasteMode, setPasteMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [credError, setCredError] = useState<string | null>(null);
  const [savingCred, setSavingCred] = useState(false);

  const handleSaveCredential = async () => {
    setCredError(null);
    const body: McpCredentialInput = {};
    if (credentialSpec.requiresSecret && secret.trim()) body.secret = secret.trim();
    if (hasBundle) {
      if (pasteMode) {
        try {
          const parsed = JSON.parse(jsonText) as Record<string, string>;
          body.bundle = parsed;
        } catch (err) {
          setCredError(`Invalid JSON: ${getErrorMessage(err)}`);
          return;
        }
      } else {
        const filled = Object.fromEntries(
          Object.entries(bundle).filter(([, v]) => v.trim() !== '')
        );
        if (Object.keys(filled).length > 0) body.bundle = filled;
      }
    }
    if (body.secret === undefined && body.bundle === undefined) {
      setCredError('Enter a value before saving.');
      return;
    }
    setSavingCred(true);
    const ok = await onSaveCredential(body);
    setSavingCred(false);
    if (ok) {
      setSecret('');
      setBundle({});
      setJsonText('');
    }
  };

  return (
    <div className={styles.serverRow} data-status={server.status}>
      <div className={styles.serverHead}>
        <button
          type="button"
          className={styles.expandBtn}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          <span className={styles.chevron} data-open={expanded}>
            ▸
          </span>
          <span className={styles.statusDot} data-status={server.status} aria-hidden />
          <span className={styles.serverName}>{server.name}</span>
          <span className={styles.serverId}>{server.id}</span>
        </button>

        <div className={styles.serverMeta}>
          <Chip size="sm" variant="outline">
            {server.transport}
          </Chip>
          {server.scope === 'per-agent' && (
            <Chip size="sm" variant="outline">
              per-agent
            </Chip>
          )}
          {server.source === 'builtin' && (
            <Chip size="sm" variant="outline">
              builtin
            </Chip>
          )}
          {server.requiresCredential && (
            <Chip size="sm" tone={server.hasCredential ? 'success' : 'warning'} variant="outline">
              {server.hasCredential ? 'credential set' : 'needs credential'}
            </Chip>
          )}
        </div>

        <div className={styles.serverActions}>
          <span
            className={styles.statusLabel}
            title={server.statusDetail ?? STATUS_TITLE[server.status]}
          >
            {STATUS_LABEL[server.status]}
          </span>
          <Switch
            checked={server.enabled}
            disabled={busy}
            onChange={(next) => onToggleEnabled(next)}
          />
        </div>
      </div>

      {expanded && (
        <div className={styles.serverBody}>
          <div className={styles.configGrid}>
            {server.transport === 'stdio' ? (
              <>
                <span className={styles.configKey}>Command</span>
                <code className={styles.configVal}>
                  {[server.command, ...server.args].filter(Boolean).join(' ') || '—'}
                </code>
              </>
            ) : (
              <>
                <span className={styles.configKey}>URL</span>
                <code className={styles.configVal}>{server.url || '—'}</code>
              </>
            )}
            {Object.keys(server.env).length > 0 && (
              <>
                <span className={styles.configKey}>Env</span>
                <code className={styles.configVal}>{Object.keys(server.env).join(', ')}</code>
              </>
            )}
            {server.status === 'disconnected' && server.statusDetail && (
              <>
                <span className={styles.configKey}>Last error</span>
                <span className={styles.statusDetail}>{server.statusDetail}</span>
              </>
            )}
            {install && (
              <>
                <span className={styles.configKey}>Package</span>
                <span
                  className={styles.installLine}
                  data-state={install.state}
                  title={installTitle(install)}
                >
                  {installLine(install)}
                  {install.state === 'installed' && install.lastError && (
                    <span className={styles.installError}>
                      Last update failed: {install.lastError}
                    </span>
                  )}
                </span>
              </>
            )}
          </div>

          {server.requiresCredential && (
            <div className={styles.credSection}>
              <div className={styles.credHeader}>
                <span className={styles.credTitle}>Credential</span>
                {server.hasCredential && (
                  <Button variant="ghost" size="xs" onClick={onDeleteCredential} disabled={busy}>
                    Remove credential
                  </Button>
                )}
              </div>

              {credentialSpec.requiresSecret && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Secret</span>
                  <TextInput
                    fullWidth
                    type="password"
                    value={secret}
                    placeholder={
                      server.hasCredential ? '•••••••• (set — type to replace)' : 'Paste secret'
                    }
                    onChange={(e) => setSecret(e.target.value)}
                  />
                </label>
              )}

              {hasBundle && !pasteMode && (
                <>
                  {credentialSpec.bundleFields.map((fieldName) => (
                    <label key={fieldName} className={styles.field}>
                      <span className={styles.fieldLabel}>{fieldName}</span>
                      <TextInput
                        fullWidth
                        type="password"
                        value={bundle[fieldName] ?? ''}
                        onChange={(e) =>
                          setBundle((prev) => ({ ...prev, [fieldName]: e.target.value }))
                        }
                      />
                    </label>
                  ))}
                  <Button variant="ghost" size="xs" onClick={() => setPasteMode(true)}>
                    Paste JSON instead
                  </Button>
                </>
              )}

              {hasBundle && pasteMode && (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>
                    Paste JSON ({credentialSpec.bundleFields.join(', ')})
                  </span>
                  <Textarea
                    value={jsonText}
                    rows={4}
                    placeholder={`{ "${credentialSpec.bundleFields[0] ?? 'field'}": "value" }`}
                    onChange={(e) => setJsonText(e.target.value)}
                  />
                  <Button variant="ghost" size="xs" onClick={() => setPasteMode(false)}>
                    Use fields instead
                  </Button>
                </label>
              )}

              {credError && (
                <div className={styles.errorBanner} role="alert">
                  {credError}
                </div>
              )}

              <Button
                variant="neutral"
                size="sm"
                loading={savingCred}
                loadingText="Saving…"
                onClick={handleSaveCredential}
              >
                Save credential
              </Button>
            </div>
          )}

          <div className={styles.serverFooter}>
            <Button
              variant="neutral"
              size="sm"
              loading={testing}
              loadingText="Testing…"
              onClick={onTest}
            >
              Test connection
            </Button>
            {install?.updatable && onUpdatePackage && (
              <Button
                variant="neutral"
                size="sm"
                loading={updating}
                loadingText="Updating…"
                disabled={busy || install.state === 'installing'}
                onClick={onUpdatePackage}
                title={
                  install.requested
                    ? `Reinstall ${install.requested}, the version the command pins`
                    : 'Install the latest version'
                }
              >
                Update
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy}>
              Edit
            </Button>
            <Button variant="danger" size="sm" onClick={onRemove} disabled={busy}>
              Delete
            </Button>
            {testResult && (
              <span className={styles.testResult} data-ok={testResult.ok} role="status">
                {testResult.ok
                  ? `✓ Connected — ${testResult.toolCount} tool${testResult.toolCount === 1 ? '' : 's'}`
                  : `✗ ${testResult.error ?? testResult.status}`}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
