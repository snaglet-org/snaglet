import { useCallback, useEffect, useState, type FC } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button } from '@desktop/components';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
import { appUpdateApi } from '@desktop/utils/api';
import {
  appUpdateUnsupportedReason,
  offerAppUpdate,
  useAppUpdateState,
} from '@desktop/utils/appUpdate';
import styles from './UpdatesView.module.scss';

type UpdateStatus = Awaited<ReturnType<typeof appUpdateApi.status>>;

function formatCheckedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Settings → Updates: the installed version, what the last release check
 * found, Check now, and Install and restart. Installing goes through the same
 * prompt and install flow as the update notification (utils/appUpdate), and
 * shows the same progress.
 */
export const UpdatesView: FC = () => {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // undefined while the shell has not answered; null when this copy can update itself.
  const [unsupported, setUnsupported] = useState<string | null | undefined>(undefined);
  const update = useAppUpdateState();

  const load = useCallback(() => {
    setError(null);
    appUpdateApi.status().then(setStatus, (err: unknown) => setError(getErrorMessage(err)));
  }, []);

  useEffect(() => {
    load();
    void appUpdateUnsupportedReason().then(setUnsupported);
  }, [load]);

  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await appUpdateApi.checkNow());
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setChecking(false);
    }
  }, []);

  if (!status && !error) {
    return (
      <div className={styles.shell}>
        <StateHint>Reading the installed version…</StateHint>
      </div>
    );
  }

  const header = (
    <header className={styles.header}>
      <h1 className={styles.title}>Updates</h1>
      <p className={styles.subtitle}>Snaglet checks GitHub for a new release once a day.</p>
    </header>
  );

  // Nothing known yet: no version, no verdict, just the reason and a retry.
  if (!status) {
    return (
      <div className={styles.shell}>
        {header}
        <div className={styles.body}>
          <section className={styles.card} aria-labelledby="updates-load-title">
            <h2 id="updates-load-title" className={styles.cardTitle}>
              Couldn’t load
            </h2>
            <p className={styles.state} role="alert">
              {error}
            </p>
            <div className={styles.actions}>
              <Button variant="ghost" size="sm" onClick={load}>
                Try again
              </Button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  const latest = status.updateAvailable ? status.latest : null;
  // After a failed check the known release is only the last one seen.
  const stale = status.lastError !== null;
  const stateLine = stale
    ? `Couldn’t check: ${status.lastError}`
    : latest
      ? `Snaglet ${latest.version} is available`
      : status.lastCheckedAt
        ? 'You’re up to date'
        : 'Not checked yet';

  // "Current" is a claim, so make it only after a check has succeeded.
  const pill = stale
    ? 'Check failed'
    : latest
      ? 'Update available'
      : status.lastCheckedAt
        ? 'Current'
        : 'Not checked';

  return (
    <div className={styles.shell}>
      {header}

      <div className={styles.body}>
        {error && (
          <div className={styles.errorBanner} role="alert">
            <span>{error}</span>
            <Button variant="ghost" size="xs" onClick={() => setError(null)}>
              Dismiss
            </Button>
          </div>
        )}

        <section className={styles.card} aria-labelledby="updates-version-title">
          <div className={styles.cardTopline}>
            <div>
              <div className={styles.eyebrow}>Installed version</div>
              <h2 id="updates-version-title" className={styles.cardTitle}>
                Snaglet {status.currentVersion}
              </h2>
            </div>
            <span className={`${styles.status} ${pill === 'Current' ? styles.statusReady : ''}`}>
              {pill}
            </span>
          </div>

          <p className={styles.state} role="status">
            {stateLine}
          </p>
          {stale && latest && (
            <p className={styles.note}>Last known release: Snaglet {latest.version}</p>
          )}
          {status.lastCheckedAt && (
            <p className={styles.note}>
              {stale ? 'Last successful check' : 'Last checked'}{' '}
              {formatCheckedAt(status.lastCheckedAt)}
            </p>
          )}

          {latest && unsupported && <p className={styles.note}>{unsupported}</p>}
          {update.running && update.message && <p className={styles.progress}>{update.message}</p>}
          {!update.running && update.failure && (
            <p className={styles.failure} role="alert">
              Last install attempt failed: {update.failure}
            </p>
          )}

          <div className={styles.actions}>
            {latest && unsupported === null && (
              <Button
                variant="primary"
                size="sm"
                disabled={update.running}
                onClick={() => void offerAppUpdate(latest.version)}
              >
                {update.running ? 'Installing…' : 'Install and restart'}
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={checking} onClick={() => void checkNow()}>
              {checking ? 'Checking…' : 'Check now'}
            </Button>
          </div>

          {latest && (
            <p className={styles.note}>
              <a href={latest.url} target="_blank" rel="noreferrer">
                Release notes for Snaglet {latest.version}
              </a>
            </p>
          )}
        </section>
      </div>
    </div>
  );
};
