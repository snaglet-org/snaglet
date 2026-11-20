import { useCallback, useEffect, useState, type FC } from 'react';
import { Button } from '@desktop/components/controls/Button/Button';
import { TextInput } from '@desktop/components/controls/TextInput/TextInput';
import { ConfirmModal } from '@desktop/components/Modal/ConfirmModal';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  browserProfilesApi,
  formatLastUsed,
  MAIN_PROFILE_ID,
  type BrowserProfile,
} from './browserProfilesApi';
import styles from './BrowserSettingsView.module.scss';

const OPENED_NOTE =
  'A Chrome window opened. Sign in to the accounts you want agents to use, then close it.';

/** Settings → Browser: manage the Chrome profiles agents browse with. */
export const BrowserSettingsView: FC = () => {
  const [profiles, setProfiles] = useState<BrowserProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<BrowserProfile | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProfiles(await browserProfilesApi.list());
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
      setProfiles((p) => p ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const open = (id: string) =>
    run(async () => {
      await browserProfilesApi.open(id);
      setOpenedId(id);
    });

  const setup = () =>
    run(async () => {
      await browserProfilesApi.create(MAIN_PROFILE_ID);
      await browserProfilesApi.open(MAIN_PROFILE_ID);
      setOpenedId(MAIN_PROFILE_ID);
    });

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    void run(async () => {
      await browserProfilesApi.create(name);
      setNewName('');
    });
  };

  const existing = (profiles ?? []).filter((p) => p.exists);
  const hasMain = existing.some((p) => p.id === MAIN_PROFILE_ID);

  return (
    <div className={styles.shell}>
      <div className={styles.body}>
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <span className={styles.glyph} aria-hidden>
              ◎
            </span>
            <h1 className={styles.title}>Browser</h1>
          </div>
          <p className={styles.hint}>
            Agents browse in a separate Chrome profile that Snaglet owns. Sign in once by hand, and
            only to the accounts you want agents to use; agents never type passwords.
          </p>
        </header>

        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
          </div>
        )}

        {profiles === null ? (
          <StateHint>Loading browser profiles…</StateHint>
        ) : !hasMain ? (
          <div className={styles.empty}>
            <p className={styles.hint}>No browser profile yet.</p>
            <Button variant="primary" onClick={() => void setup()} disabled={busy}>
              Set up browser profile
            </Button>
            {openedId === MAIN_PROFILE_ID && <p className={styles.note}>{OPENED_NOTE}</p>}
          </div>
        ) : null}

        {existing.length > 0 && (
          <ul className={styles.list}>
            {existing.map((p) => (
              <li key={p.id} className={styles.row} data-testid={`browser-profile-${p.id}`}>
                <div className={styles.rowMain}>
                  <div className={styles.rowTop}>
                    <strong>{p.name}</strong>
                    {p.running && <span className={styles.badge}>Running</span>}
                  </div>
                  <span className={styles.meta}>{formatLastUsed(p.lastUsedAt)}</span>
                  {openedId === p.id && <p className={styles.note}>{OPENED_NOTE}</p>}
                </div>
                <div className={styles.rowActions}>
                  <Button
                    variant="neutral"
                    size="sm"
                    onClick={() => void open(p.id)}
                    disabled={busy}
                  >
                    Sign in / manage
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirmDelete(p)}
                    disabled={busy || p.running}
                    title={p.running ? 'Close the Chrome window first' : undefined}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {profiles !== null && (
          <div className={styles.newRow}>
            <TextInput
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New profile name"
              aria-label="New profile name"
              onKeyDown={(e) => {
                if (e.key === 'Enter') create();
              }}
            />
            <Button variant="neutral" onClick={create} disabled={busy || !newName.trim()}>
              New profile
            </Button>
          </div>
        )}
      </div>

      {confirmDelete && (
        <ConfirmModal
          title={`Delete profile "${confirmDelete.name}"?`}
          confirmLabel="Delete"
          destructive
          onConfirm={() => {
            const { id } = confirmDelete;
            setConfirmDelete(null);
            void run(() => browserProfilesApi.remove(id));
          }}
          onCancel={() => setConfirmDelete(null)}
        >
          Its saved sign-ins and cookies will be removed. Agents will need you to sign in again.
        </ConfirmModal>
      )}
    </div>
  );
};
