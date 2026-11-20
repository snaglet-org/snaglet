import { useEffect, useState, type FC } from 'react';
import type { AgentStatus } from '../hooks/types';
import styles from './AgentStatusBubbles.module.scss';

interface AgentStatusBubblesProps {
  statuses: Map<string, AgentStatus>;
  agentNameById: Map<string, string>;
  onStopAgent?: (agentId: string) => void;
}

const LABEL: Record<AgentStatus, string> = {
  thinking: 'thinking…',
  typing: 'typing…',
  tool_running: 'running tool…',
  compacting: 'compacting…',
  queued: 'queued…',
};

/** States with no run to stop: a compaction, or a queued run that has not started. */
const NOT_STOPPABLE: ReadonlySet<AgentStatus> = new Set(['compacting', 'queued']);

/**
 * Renders one pill per currently-active agent — `● [patty] typing…`.
 * Returns null when nothing is active so the row collapses out of the
 * layout entirely (no empty row eating composer space).
 */
export const AgentStatusBubbles: FC<AgentStatusBubblesProps> = ({
  statuses,
  agentNameById,
  onStopAgent,
}) => {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());

  // Drop pending marks for agents whose run has ended (pill gone), so a
  // later run for the same agent starts with an enabled Stop control.
  useEffect(() => {
    setStopping((prev) => {
      const next = new Set<string>();
      for (const id of prev) if (statuses.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [statuses]);

  if (statuses.size === 0) return null;

  return (
    <div className={styles.row}>
      {Array.from(statuses.entries()).map(([agentId, status]) => {
        const name = agentNameById.get(agentId) ?? agentId.slice(0, 8);
        const isStopping = stopping.has(agentId);
        return (
          <div key={agentId} className={styles.bubble}>
            <span className={styles.dot} data-status={status} aria-hidden />
            <span className={styles.name}>[{name}]</span>
            <span className={styles.status}>{LABEL[status]}</span>
            {onStopAgent && !NOT_STOPPABLE.has(status) && (
              <button
                type="button"
                className={styles.stop}
                onClick={() => {
                  setStopping((prev) => new Set(prev).add(agentId));
                  onStopAgent(agentId);
                }}
                disabled={isStopping}
                aria-label={`Stop ${name} run`}
                title={isStopping ? 'Stopping…' : `Stop ${name} run`}
              >
                <span className={styles.stopIcon} aria-hidden />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
