import { useCallback, useEffect, useState, type FC } from 'react';
import { agentsApi } from '@desktop/utils/api';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { subscribeAgentEvents } from '@desktop/utils/agentEvents';
import { Tree, TreeRow } from '@desktop/components/SidebarTree';
import type { SnagletAgent } from '@snaglet/shared/types';
import styles from './AgentsList.module.scss';
import { getErrorMessage } from '@snaglet/shared/utils';
import { defaultCursorSpec } from '@snaglet/shared/cursor';
import { FlowerAvatar } from '@desktop/components/agentCursor/FlowerAvatar';

/** The roster avatar is the agent's generated flower; 40px is where its face reads. */
const ROW_AVATAR_SIZE = 40;

// Mirrors the MIME used by the LibraryTree → ArchiveDropZone path. Repeated
// locally here (rather than imported from a shared module) to match every
// other consumer in the codebase — same pattern as ContainerView, etc.
const TREE_NODE_MIME = 'application/x-snaglet-tree-node';

interface AgentsListProps {
  /** Fires when an agent row is clicked. */
  onAgentClick?: (agent: SnagletAgent) => void;
  /** Optional: highlight the currently selected agent id. */
  selectedAgentId?: string | null;
  /**
   * Bump to force the list to refetch — used after the sidebar creates a
   * new agent so the row appears without a remount.
   */
  refreshNonce?: number;
  /**
   * When set, the row whose `id` matches gets the reveal pulse animation.
   * Used by the parent AgentsView's cross-view search reveal effect — it
   * sets this transiently (1.6s) so the just-scrolled-to row is easy to
   * spot.
   */
  pulseAgentId?: string | null;
}

/**
 * AgentsList — the agent roster in the shared SidebarTree frame.
 *
 * Agents are actors, not content, so they don't live in the container
 * tree — they get their own roster. Click an agent to surface its
 * config in the active pane; drag a row onto pane chrome to open it in
 * a split (the kit writes the pane payload), or onto the trash to
 * archive (the TREE_NODE_MIME added below).
 */
const AgentsList: FC<AgentsListProps> = ({
  onAgentClick,
  selectedAgentId = null,
  refreshNonce = 0,
  pulseAgentId = null,
}) => {
  const [agents, setAgents] = useState<SnagletAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Internal refresh counter, bumped when something archives an agent we're
  // showing (the server-side filter already excludes archived agents from
  // `agentsApi.list()`, so a refetch drops it) and after a reconnect.
  const [localRefreshNonce, setLocalRefreshNonce] = useState(0);

  const fetchAgents = useCallback(async (signal: { canceled: boolean }) => {
    try {
      const rows = await agentsApi.list();
      if (signal.canceled) return;
      // Alphabetical: the agent row has no activity timestamp to sort by.
      const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
      setAgents(sorted);
    } catch (err) {
      if (signal.canceled) return;
      setError(getErrorMessage(err, 'Failed to load agents'));
    }
  }, []);

  useEffect(() => {
    const signal = { canceled: false };
    void fetchAgents(signal);
    return () => {
      signal.canceled = true;
    };
  }, [refreshNonce, localRefreshNonce, fetchAgents]);

  // Refetch when an archive-changed event touches one of our agents — the
  // drop zone fires this after a successful archive. We could narrow to
  // "is one of these ids in our current list?" but the call is cheap and
  // the list is small.
  useEffect(() => {
    return onLibraryEvent((event) => {
      if (event.type === 'archive-changed') {
        setLocalRefreshNonce((n) => n + 1);
      }
    });
  }, []);

  // After a reconnect: agent changes made while the socket was down are not
  // replayed, so reread the roster (each `agent.updated` arrives through
  // `refreshNonce`).
  useEffect(
    () =>
      subscribeAgentEvents((event) => {
        if (event.type === 'agents.invalidated') setLocalRefreshNonce((n) => n + 1);
      }),
    []
  );

  if (error)
    return (
      <div data-sidebar-agents="error" className={styles.error}>
        {error}
      </div>
    );
  if (agents === null)
    return (
      <div data-sidebar-agents="loading" className={styles.loading}>
        Loading…
      </div>
    );
  if (agents.length === 0)
    return (
      <div data-sidebar-agents="ready" className={styles.empty}>
        No agents
      </div>
    );

  return (
    <div data-sidebar-agents="ready">
      <Tree>
        {agents.map((agent) => {
          const displayName = agent.name || 'Untitled agent';
          return (
            <TreeRow
              key={agent.id}
              role="treeitem"
              chevron="empty"
              data-reveal-id={agent.id}
              data-inspect-agent-id={agent.id}
              data-inspect-name={displayName}
              data-inspect-role={agent.role?.trim() || 'No role set'}
              data-inspect-selected={selectedAgentId === agent.id}
              selected={selectedAgentId === agent.id}
              reveal={pulseAgentId === agent.id}
              paneSelection={{ kind: 'agent', agent }}
              onClick={() => onAgentClick?.(agent)}
              onDragStart={(e) => {
                // TREE_NODE_MIME: drop into the archive trash to archive
                // the agent. (The pane payload comes from paneSelection.)
                // WorkspaceTree's reparent handler only acts on MOVABLE
                // kinds, so dropping an agent on the tree silently no-ops.
                e.dataTransfer.setData(
                  TREE_NODE_MIME,
                  JSON.stringify({ id: agent.id, kind: 'agent' })
                );
              }}
              title={agent.role ? `${displayName} — ${agent.role}` : displayName}
            >
              <span
                className={`${styles.avatar} ${agent.avatarUrl ? '' : styles.avatarFlower}`}
                data-testid="agent-row-avatar"
                aria-hidden
              >
                {agent.avatarUrl ? (
                  <img src={agent.avatarUrl} alt="" className={styles.avatarImg} />
                ) : (
                  <FlowerAvatar
                    spec={agent.cursorSpec ?? defaultCursorSpec(agent.id)}
                    emotion="neutral"
                    size={ROW_AVATAR_SIZE}
                  />
                )}
              </span>
              <span className={styles.identity}>
                <span className={styles.name}>{displayName}</span>
                <span className={styles.role}>{agent.role?.trim() || 'No role set'}</span>
              </span>
            </TreeRow>
          );
        })}
      </Tree>
    </div>
  );
};

export { AgentsList };
