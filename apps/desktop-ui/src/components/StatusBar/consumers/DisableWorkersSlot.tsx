import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { automaticIndexingMessage } from '@desktop/utils/automaticIndexing';
import { workersApi } from '@desktop/utils/api';
import type { WorkerStatusResponse } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import { useStatusBarSlot } from '../StatusBarContext';
import type { StatusBarSlot } from '../types';
import styles from './DisableWorkersSlot.module.scss';

/**
 * Status-bar popover with "Disable hooks" and "Disable embeddings workers"
 * switches. The policy flags are `hooksEnabled` / `embeddingsEnabled`, so a
 * checked "Disable" box saves the flag as false.
 *
 * When `envEnabled === false`, background work is off at the environment
 * level and the switches show as disabled with a note.
 *
 * Headless: registers a `toggle` slot and renders null.
 */

/** How often the popover refreshes the live policy readout while relevant. */
const POLL_INTERVAL_MS = 5_000;

type PolicyKey = 'hooksEnabled' | 'embeddingsEnabled';

export const DisableWorkersSlot: FC = () => {
  const [status, setStatus] = useState<WorkerStatusResponse | null>(null);
  const [saving, setSaving] = useState<PolicyKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when a save starts and when it ends: a status read that began
  // before or during a save is stale when it lands, and would show the
  // pre-save policy until the next poll.
  const saves = useRef(0);

  useEffect(() => {
    let canceled = false;
    const load = async (): Promise<void> => {
      const savesAtStart = saves.current;
      try {
        const next = await workersApi.status();
        if (!canceled && savesAtStart === saves.current) {
          setStatus(next);
          setError(null);
        }
      } catch (err) {
        if (!canceled) setError(getErrorMessage(err, "Couldn't load the worker status"));
      }
    };
    void load();
    const handle = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      canceled = true;
      window.clearInterval(handle);
    };
  }, []);

  const setEnabled = useCallback(async (key: PolicyKey, enabled: boolean) => {
    saves.current += 1;
    setSaving(key);
    setError(null);
    try {
      const next = await workersApi.savePolicy({ [key]: enabled });
      setStatus((current) => (current ? { ...current, policy: next } : current));
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't save the worker setting"));
    } finally {
      saves.current += 1;
      setSaving(null);
    }
  }, []);

  const policy = status?.policy ?? null;
  const envEnabled = policy?.envEnabled ?? true;
  // "Any background process off" drives the resting tone so the bar hints
  // that something is paused without shouting about it.
  const anyDisabled =
    policy != null && (policy.hooksEnabled === false || policy.embeddingsEnabled === false);

  const slot = useMemo<StatusBarSlot>(() => {
    const rows: Array<{ key: PolicyKey; label: string; help: string }> = [
      {
        key: 'hooksEnabled',
        label: 'Disable scripts',
        help: 'Stop running scripts on workspace events and their schedules.',
      },
      {
        key: 'embeddingsEnabled',
        label: 'Disable background embeddings workers',
        help: 'Stop backfilling missing and stale search embeddings.',
      },
    ];

    return {
      id: 'disable-workers',
      zone: 'right',
      order: 20,
      item: {
        type: 'toggle',
        label: 'Workers',
        tone: anyDisabled ? 'warning' : 'muted',
        active: anyDisabled,
        title: 'Background workers: scripts and embeddings',
        icon: <span aria-hidden="true">⚙</span>,
        render: () => (
          <div className={styles.popover}>
            <div className={styles.heading}>Background workers</div>
            <div className={styles.envNote} role="note">
              {automaticIndexingMessage(status)}
            </div>
            {!envEnabled && (
              <div className={styles.envNote} role="note">
                Background work is turned off at the environment level, so these switches are
                inactive.
              </div>
            )}
            {error && (
              <div className={styles.error} role="alert">
                {error}
              </div>
            )}
            <div className={styles.rows}>
              {rows.map(({ key, label, help }) => {
                // Checked "Disable" == the *Enabled* flag is false.
                const disabledChecked = policy ? policy[key] === false : false;
                return (
                  <label key={key} className={styles.row}>
                    <input
                      type="checkbox"
                      aria-label={label}
                      checked={disabledChecked}
                      disabled={!envEnabled || saving === key}
                      onChange={(e) => void setEnabled(key, !e.target.checked)}
                    />
                    <span className={styles.copy}>
                      <strong>{label}</strong>
                      <small>{help}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ),
      },
    };
  }, [anyDisabled, envEnabled, error, policy, saving, setEnabled, status]);

  useStatusBarSlot(slot);
  return null;
};
