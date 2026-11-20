import type { ThreadTreeNode } from '../../utils/api';
import { ThreadAgentRow } from './ThreadAgentRow';
import { TreeGroupHeader } from './TreeGroupHeader';
import { guideStyle, rowIndent } from './treeUtils';
import styles from './WorkspaceTree.module.scss';
import type { ThreadAgentEntry } from './types';

interface ThreadAgentsGroupProps {
  thread: ThreadTreeNode;
  depth: number;
  /**
   * Per-thread participant cache. Lazy-loaded on thread expand;
   * `undefined`/`null` is the in-flight sentinel.
   */
  threadAgents: Map<string, { entries: ThreadAgentEntry[] } | null>;
  /** Per-thread "Agents" group header expansion (nested under thread row). */
  expandedThreadAgentGroups: Set<string>;
  toggleThreadAgentGroup: (threadId: string) => void;
}

/**
 * Nested "Agents" group revealed under an expanded thread row. The group is
 * a single dropdown leaf — mirrors the "Tasks" group under project-home
 * rows: same chevron, same indentation, same row chrome. Lazy-loaded on
 * first expand; the cache hit/miss drives the loading / empty states. We
 * deliberately do not render the group when there are zero participants
 * (per spec: "If the thread has zero agents, the 'Agents' leaf does not
 * render — no empty dropdowns").
 */
export function ThreadAgentsGroup({
  thread,
  depth,
  threadAgents,
  expandedThreadAgentGroups,
  toggleThreadAgentGroup,
}: ThreadAgentsGroupProps) {
  const cached = threadAgents.get(thread.id);
  const loading = cached === undefined || cached === null;
  const entries = cached?.entries ?? [];
  const groupOpen = expandedThreadAgentGroups.has(thread.id);
  if (loading) {
    return (
      <div
        className={styles.taskHint}
        style={{ paddingLeft: rowIndent(depth + 1) }}
        aria-live="polite"
      >
        Loading agents…
      </div>
    );
  }
  if (entries.length === 0) {
    // Per spec — no empty dropdowns. Render nothing.
    return null;
  }
  return (
    <div role="group" className={styles.indentGuide} style={guideStyle(depth)}>
      <TreeGroupHeader
        label="Agents"
        count={entries.length}
        open={groupOpen}
        onToggle={() => toggleThreadAgentGroup(thread.id)}
        depth={depth + 1}
      />
      {groupOpen &&
        entries.map((entry) => (
          <ThreadAgentRow
            key={entry.participant.agentId}
            thread={thread}
            entry={entry}
            depth={depth + 2}
          />
        ))}
    </div>
  );
}
