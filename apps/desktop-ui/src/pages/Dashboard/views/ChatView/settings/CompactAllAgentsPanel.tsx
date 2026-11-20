import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
// Import Button/Modal/layout from their source files rather than the
// '@desktop/components' barrel: the barrel re-exports WsStatusIndicator, which
// pulls the ws context + client config at module-eval and throws under vitest
// (no VITE_API_BASE_URL). The layout primitives ship from their own
// dependency-light barrel, so they're safe to pull here.
import { Button } from '@desktop/components/controls/Button/Button';
import { Modal } from '@desktop/components/Modal/Modal';
import { Cluster, Section, Stack } from '@desktop/components/layout';
import { threadsApi } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import { InfoHint } from './InfoHint';
import { loadThreadAgents } from './threadAgents';
import styles from './CompactAllAgentsPanel.module.scss';

/** Per-agent state while a bulk compaction sweeps the thread. */
export type CompactAgentStatus = 'pending' | 'running' | 'done' | 'error';

export interface CompactAllResult {
  succeeded: string[];
  failed: Array<{ agentId: string; error: string }>;
}

/**
 * Fan the per-agent compaction out across a list of agents **sequentially**.
 *
 * Sequential is deliberate: each compaction is a model call, so firing them
 * in parallel would stampede the providers. We run one at a time, awaiting
 * each before starting the next. A single agent failing is reported through
 * `onProgress(id, 'error', msg)` and collected in `failed`, but never aborts
 * the remaining agents.
 *
 * Pure orchestration — the caller injects `compactOne` (bound to the real
 * `threadsApi.compactAgent`) and an `onProgress` sink that drives UI state.
 * Keeping the send injectable is what makes the fan-out unit-testable.
 */
export async function runCompactAll(
  agentIds: string[],
  compactOne: (agentId: string) => Promise<unknown>,
  onProgress: (
    agentId: string,
    status: Exclude<CompactAgentStatus, 'pending'>,
    error?: string
  ) => void
): Promise<CompactAllResult> {
  const succeeded: string[] = [];
  const failed: Array<{ agentId: string; error: string }> = [];
  for (const agentId of agentIds) {
    onProgress(agentId, 'running');
    try {
      await compactOne(agentId);
      succeeded.push(agentId);
      onProgress(agentId, 'done');
    } catch (err) {
      const message = getErrorMessage(err, 'Compaction failed');
      failed.push({ agentId, error: message });
      onProgress(agentId, 'error', message);
    }
  }
  return { succeeded, failed };
}

interface CompactAgent {
  agentId: string;
  name: string;
}

interface CompactAllAgentsPanelProps {
  threadId: string;
}

const STATUS_LABEL: Record<CompactAgentStatus, string> = {
  pending: 'Queued',
  running: 'Compressing…',
  done: 'Done',
  error: 'Failed',
};

const STATUS_CLASS: Record<CompactAgentStatus, string> = {
  pending: '',
  running: styles.statusRunning,
  done: styles.statusDone,
  error: styles.statusError,
};

/**
 * "Compress all" panel for the thread settings → Context tab.
 *
 * Reuses the existing per-agent compaction op (`threadsApi.compactAgent`,
 * the same call `ContextWindowPanel`'s per-agent Compact button fires) and
 * fans it out across every agent participant in the thread — sequentially,
 * with a small per-agent progress list. A confirmation dialog fronts the
 * sweep because it rewrites every agent's context; the trigger is disabled
 * while a run is in flight; and one agent failing is surfaced inline without
 * stopping the others.
 */
export const CompactAllAgentsPanel: FC<CompactAllAgentsPanelProps> = ({ threadId }) => {
  const [agents, setAgents] = useState<CompactAgent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, CompactAgentStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CompactAllResult | null>(null);

  // Guards state writes from an in-flight sweep after the panel unmounts
  // (e.g. the user switches settings tabs mid-run).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load the thread's agent participants (joined with agent records for
  // display names), the same join AgentsSection uses. Human (kind: 'user')
  // participants are excluded — this compacts agent contexts only.
  useEffect(() => {
    let canceled = false;
    setAgents(null);
    setLoadError(null);
    setConfirmOpen(false);
    setRunning(false);
    setStatuses({});
    setErrors({});
    setResult(null);

    loadThreadAgents(threadId)
      .then(({ participants, agentById }) => {
        if (canceled) return;
        const seen = new Set<string>();
        const next: CompactAgent[] = [];
        for (const p of participants) {
          if (p.kind !== 'agent' || !p.agentId || seen.has(p.agentId)) continue;
          seen.add(p.agentId);
          next.push({
            agentId: p.agentId,
            name: agentById.get(p.agentId)?.name ?? p.agentId.slice(0, 8),
          });
        }
        setAgents(next);
      })
      .catch((err) => {
        if (!canceled) setLoadError(getErrorMessage(err, 'Failed to load thread agents'));
      });

    return () => {
      canceled = true;
    };
  }, [threadId]);

  const runAll = useCallback(async () => {
    if (!agents || agents.length === 0 || running) return;
    const agentIds = agents.map((a) => a.agentId);
    setRunning(true);
    setResult(null);
    setErrors({});
    setStatuses(Object.fromEntries(agentIds.map((id) => [id, 'pending' as CompactAgentStatus])));
    try {
      const res = await runCompactAll(
        agentIds,
        (id) => threadsApi.compactAgent(threadId, id),
        (id, status, error) => {
          if (!mountedRef.current) return;
          setStatuses((prev) => ({ ...prev, [id]: status }));
          if (status === 'error' && error) {
            setErrors((prev) => ({ ...prev, [id]: error }));
          }
        }
      );
      if (mountedRef.current) setResult(res);
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  }, [agents, running, threadId]);

  const handleConfirm = useCallback(() => {
    setConfirmOpen(false);
    void runAll();
  }, [runAll]);

  const completedCount = useMemo(
    () => Object.values(statuses).filter((s) => s === 'done' || s === 'error').length,
    [statuses]
  );

  if (agents === null && !loadError) {
    return (
      <div className={styles.panel}>
        <div className={styles.hint}>Loading agents…</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={styles.panel}>
        <div className={styles.loadError} role="alert">
          {loadError}
        </div>
      </div>
    );
  }

  const agentCount = agents?.length ?? 0;
  const showProgress = running || result !== null;

  return (
    <Section label="Compress all contexts" className={styles.panel}>
      <p className={styles.description}>
        Summarize older messages for every agent to shrink their prompts.
        <InfoHint
          topic="compacting every agent"
          text={
            "The same operation as each agent's per-agent Compact button, fanned out across all participants and run one at a time."
          }
        />
      </p>

      {agentCount === 0 ? (
        <div className={styles.hint}>No agents in this thread to compress.</div>
      ) : (
        <Stack gap={2}>
          <Cluster gap={3}>
            <Button
              variant="neutral"
              size="sm"
              disabled={running}
              onClick={() => setConfirmOpen(true)}
              title="Compress the context of every agent in this thread"
            >
              {running
                ? `Compressing… (${completedCount}/${agentCount})`
                : `Compress all (${agentCount})`}
            </Button>
            {result && (
              <span
                className={`${styles.summary} ${
                  result.failed.length > 0 ? styles.summaryHasFailures : ''
                }`}
              >
                Compressed {result.succeeded.length} of {agentCount}
                {result.failed.length > 0 ? ` · ${result.failed.length} failed` : ''}
              </span>
            )}
          </Cluster>

          {showProgress && (
            <ul className={styles.progress} aria-live="polite">
              {(agents ?? []).map((a) => {
                const status = statuses[a.agentId] ?? 'pending';
                return (
                  <li key={a.agentId} className={styles.progressItem}>
                    <span className={styles.agentName} title={a.name}>
                      {a.name}
                    </span>
                    <span className={`${styles.status} ${STATUS_CLASS[status]}`}>
                      {STATUS_LABEL[status]}
                    </span>
                    {status === 'error' && errors[a.agentId] && (
                      <span className={styles.errorText}>{errors[a.agentId]}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Stack>
      )}

      {confirmOpen && (
        <Modal onClose={() => setConfirmOpen(false)}>
          <Modal.Header>Compress all agent contexts?</Modal.Header>
          <Modal.Body>
            <p className={styles.confirmMessage}>
              This compacts{' '}
              <strong>
                {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
              </strong>{' '}
              one at a time — it calls the model for each, so it can take a while.
            </p>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="neutral" size="sm" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleConfirm}>
              Compress all
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </Section>
  );
};
