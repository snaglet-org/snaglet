import { useCallback, useEffect, useState, type FC } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button } from '@desktop/components';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
import { isTauriEnv } from '@desktop/utils/tauriEnv';
import styles from './CliSettingsView.module.scss';

export interface CliInstallStatus {
  available: boolean;
  installed: boolean;
  current: boolean;
  conflict: boolean;
  launcherPath: string;
  cliPath: string;
  pathConfigured: boolean;
  pathExportCommand: string;
}

/** How long the PATH command's button reads "Copied". */
const COPIED_NOTICE_MS = 1500;

async function invokeCli<T>(command: string): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command);
}

export const CliSettingsView: FC = () => {
  const [status, setStatus] = useState<CliInstallStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    // Outside a Tauri shell (e.g. the plain-browser Vite dev shell) there is
    // no bridge to invoke — leave `status` null so the view renders its
    // graceful "Not installed" / dev-shell state instead of an error banner.
    if (!isTauriEnv()) {
      setLoading(false);
      return;
    }
    try {
      setStatus(await invokeCli<CliInstallStatus>('cli_install_status'));
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const runAction = async (command: 'install_cli' | 'uninstall_cli') => {
    if (!isTauriEnv()) return;
    setBusy(true);
    setCopied(false);
    try {
      setStatus(await invokeCli<CliInstallStatus>(command));
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const copyPathCommand = async () => {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(status.pathExportCommand);
      setCopied(true);
    } catch (err) {
      setCopied(false);
      setError(getErrorMessage(err, 'Could not copy the command. Select it and copy it by hand.'));
    }
  };

  if (loading) {
    return (
      <div className={styles.shell}>
        <StateHint>Checking command-line installation…</StateHint>
      </div>
    );
  }

  const stateLabel = status?.conflict
    ? 'Existing command found'
    : status?.current
      ? 'Installed'
      : status?.installed
        ? 'Update available'
        : 'Not installed';

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.title}>Command line</h1>
        <p className={styles.subtitle}>
          Run scripts and the MCP bridge from Terminal using Snaglet’s bundled runtime. A system
          Node installation is not required.
        </p>
      </header>

      <div className={styles.body}>
        {error && (
          <div className={styles.errorBanner} role="alert">
            <span>{error}</span>
            <Button variant="ghost" size="xs" onClick={() => setError(null)}>
              Dismiss
            </Button>
          </div>
        )}

        <section className={styles.installCard} aria-labelledby="cli-install-title">
          <div className={styles.cardTopline}>
            <div>
              <div className={styles.eyebrow}>Terminal command</div>
              <h2 id="cli-install-title" className={styles.cardTitle}>
                <code>snaglet</code>
              </h2>
            </div>
            <span className={`${styles.status} ${status?.current ? styles.statusReady : ''}`}>
              {stateLabel}
            </span>
          </div>

          <div className={styles.commandPreview} aria-label="Example Snaglet command">
            <span aria-hidden="true">$</span> snaglet hook list
          </div>

          {status?.conflict && (
            <p className={styles.warning}>
              Snaglet will not overwrite the existing executable at{' '}
              <code>{status.launcherPath}</code>.
            </p>
          )}

          {!status?.available && (
            <p className={styles.note}>
              CLI installation is available in packaged Snaglet builds. This development shell does
              not contain the staged runtime.
            </p>
          )}

          <div className={styles.actions}>
            {!status?.current ? (
              <Button
                variant="primary"
                size="sm"
                disabled={busy || !status?.available || status?.conflict}
                onClick={() => void runAction('install_cli')}
              >
                {busy ? 'Installing…' : status?.installed ? 'Update CLI' : 'Install CLI'}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void runAction('uninstall_cli')}
              >
                {busy ? 'Removing…' : 'Remove CLI'}
              </Button>
            )}
          </div>

          {status?.installed && (
            <dl className={styles.details}>
              <div>
                <dt>Launcher</dt>
                <dd>{status.launcherPath}</dd>
              </div>
              <div>
                <dt>Bundled CLI</dt>
                <dd>{status.cliPath}</dd>
              </div>
            </dl>
          )}
        </section>

        {status?.current && !status.pathConfigured && (
          <section className={styles.pathCard} aria-labelledby="cli-path-title">
            <div>
              <div className={styles.eyebrow}>One shell step</div>
              <h2 id="cli-path-title" className={styles.pathTitle}>
                Add the launcher to PATH
              </h2>
              <p>
                Add this line to <code>~/.zprofile</code>, then open a new Terminal window.
              </p>
            </div>
            <div className={styles.pathCommand}>
              <code>{status.pathExportCommand}</code>
              <Button variant="ghost" size="xs" onClick={() => void copyPathCommand()}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
