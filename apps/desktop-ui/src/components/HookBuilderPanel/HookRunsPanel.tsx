import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@desktop/components';
import { ConfirmModal } from '@desktop/components/Modal';
import { agentsApi, hookRunsApi } from '@desktop/utils/api';
import { invalidateHookRuns, useHookRuns, useHookRunsRevision } from '@desktop/utils/hookRunState';
import type { HookRunRecord } from '@snaglet/shared/types';
import { getErrorMessage, relativeFromNow } from '@snaglet/shared/utils';
import styles from './HookBuilderPanel.module.scss';

interface HookRunsPanelProps {
  hookName: string;
}

function durationLabel(run: HookRunRecord): string {
  if (run.status === 'running') return 'running';
  if (run.durationMs === null) return '—';
  if (run.durationMs < 1000) return `${run.durationMs}ms`;
  return `${(run.durationMs / 1000).toFixed(run.durationMs < 10_000 ? 1 : 0)}s`;
}

function sourceLabel(run: HookRunRecord): string {
  if (run.source === 'manual') return 'Manual';
  if (run.source === 'schedule') return 'Schedule';
  return 'Event';
}

/**
 * Agent names by id, for "as <Agent>" on runs that acted as an agent (its
 * run-as agent, or the agent whose event it observed). Archived agents are
 * included: this names who a past run acted as. A failed load shows ids.
 */
function useAgentNames(): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let canceled = false;
    agentsApi
      .list({ includeArchived: true })
      .then((agents) => {
        if (!canceled) setNames(new Map(agents.map((agent) => [agent.id, agent.name])));
      })
      .catch((err: unknown) => {
        // Names are decoration: the runs show agent ids instead.
        console.warn('[hooks] agent names for the run log did not load:', getErrorMessage(err));
      });
    return () => {
      canceled = true;
    };
  }, []);
  return names;
}

export function HookRunsPanel({ hookName }: HookRunsPanelProps) {
  const allRuns = useHookRuns();
  const agentNames = useAgentNames();
  const revision = useHookRunsRevision(hookName);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HookRunRecord[]>([]);
  const runs = useMemo(() => {
    const merged = new Map(
      history.filter((run) => run.hookName === hookName).map((run) => [run.id, run])
    );
    for (const run of allRuns) {
      if (run.hookName === hookName) merged.set(run.id, run);
    }
    return Array.from(merged.values()).sort(
      (a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)
    );
  }, [allRuns, history, hookName]);

  // Only the newest read lands: an older one (or one from before a clear)
  // resolving late must not put back the rows it saw.
  const requestRef = useRef(0);
  const load = useCallback(
    async (refresh = false) => {
      const request = ++requestRef.current;
      if (refresh) setRefreshing(true);
      else setLoading(true);
      try {
        const rows = await hookRunsApi.listForHook(hookName, 100);
        if (request !== requestRef.current) return;
        setHistory(rows);
        setError(null);
      } catch (err) {
        if (request !== requestRef.current) return;
        setError(getErrorMessage(err, "Couldn't load runs"));
      } finally {
        if (request === requestRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [hookName]
  );

  useEffect(() => {
    void load();
  }, [load, revision]);

  // Confirmation goes through the in-app ConfirmModal, NOT window.confirm:
  // the Tauri webview suppresses browser-native dialogs (they return falsy
  // without ever showing), which made "Clear history" die silently in the
  // desktop app. The modal closes on confirm; the button's own `clearing`
  // spinner and the panel's error line carry in-flight/failure state exactly
  // as before (same close-then-run shape as ToolsView's delete).
  const [confirmingClear, setConfirmingClear] = useState(false);
  const clearHistory = useCallback(async () => {
    setClearing(true);
    try {
      await hookRunsApi.clearForHook(hookName);
      requestRef.current += 1;
      setLoading(false);
      setRefreshing(false);
      setHistory([]);
      setError(null);
      invalidateHookRuns([hookName]);
    } catch (err) {
      setError(getErrorMessage(err, "Couldn't clear the run history"));
    } finally {
      setClearing(false);
    }
  }, [hookName]);

  return (
    <section className={styles.hookRunsPanel} aria-label={`Runs for ${hookName}`}>
      <div className={styles.hookRunsHeader}>
        <div className={styles.scheduleLead}>
          <span className={styles.fieldLabel}>Execution ledger</span>
          <span className={styles.fieldHint}>
            Manual, scheduled, and workspace-event runs appear here as they happen.
          </span>
        </div>
        <div className={styles.hookRunsActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmingClear(true)}
            loading={clearing}
            loadingText="Clearing"
          >
            Clear history
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load(true)}
            loading={refreshing}
            loadingText="Refreshing"
          >
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <pre className={styles.formError} role="alert">
          {error}
        </pre>
      )}

      {loading && runs.length === 0 ? (
        <div className={styles.emptySchedule}>Loading runs…</div>
      ) : runs.length === 0 ? (
        // After a failed read the error above says so; "No runs yet" would be a guess.
        !error && (
          <div className={styles.emptySchedule}>
            No runs yet. Trigger this script or use the test console in Code.
          </div>
        )
      ) : (
        <ol className={styles.hookRunList}>
          {runs.map((run) => {
            const hasOutput = Boolean(run.stdout?.trim() || run.stderr?.trim());
            return (
              <li
                key={run.id}
                className={styles.hookRunCard}
                data-status={run.status}
                aria-label={`${run.eventName}: ${run.status}`}
              >
                <span className={styles.hookRunRail} aria-hidden="true" />
                <div className={styles.hookRunBody}>
                  <div className={styles.hookRunTop}>
                    <div className={styles.hookRunIdentity}>
                      <strong>{run.eventName}</strong>
                      <span>{sourceLabel(run)}</span>
                    </div>
                    <span className={styles.hookRunStatus}>{run.status.replace('_', ' ')}</span>
                  </div>
                  <div className={styles.hookRunMeta}>
                    <span>{relativeFromNow(run.startedAt)}</span>
                    <span>{durationLabel(run)}</span>
                    {run.agentId && <span>as {agentNames.get(run.agentId) ?? run.agentId}</span>}
                    {run.threadId && <span>thread {run.threadId}</span>}
                    {run.exitCode !== null && <span>exit {run.exitCode}</span>}
                  </div>
                  {hasOutput && (
                    <details className={styles.hookRunOutput}>
                      <summary>Output</summary>
                      {run.stdout?.trim() && (
                        <pre>
                          <span>stdout</span>
                          {run.stdout}
                        </pre>
                      )}
                      {run.stderr?.trim() && (
                        <pre>
                          <span>stderr</span>
                          {run.stderr}
                        </pre>
                      )}
                    </details>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {confirmingClear && (
        <ConfirmModal
          title={`Clear all run history for "${hookName}"?`}
          confirmLabel="Clear history"
          destructive
          onConfirm={() => {
            setConfirmingClear(false);
            void clearHistory();
          }}
          onCancel={() => setConfirmingClear(false)}
        >
          This cannot be undone and will fail if an invocation is queued or running.
        </ConfirmModal>
      )}
    </section>
  );
}
