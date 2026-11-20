import { useCallback, useEffect, useState } from 'react';
import type { LibraryTreeChild } from '../../../utils/api';
import { EXPANDED_STORAGE_KEY } from '../constants';
import { collectDescendantIds, findNodeInRoots, loadExpanded } from '../treeUtils';

export interface UseTreeExpansionArgs {
  /** Loaded tree roots — needed to collapse a node's descendants on expand. */
  roots: LibraryTreeChild[] | null;
}

/**
 * All expansion state for the workspace tree: the localStorage-persisted
 * container/doc/thread `expanded` set and the per-thread "Agents" group
 * headers, plus the toggle functions for each. `toggle` additionally
 * collapses a container's descendants across every secondary set when it
 * expands, so opening a container never recursively reveals whatever was
 * open under it before.
 */
export function useTreeExpansion({ roots }: UseTreeExpansionArgs) {
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded());
  // Per-thread expansion state for the nested "Agents" group header. The
  // outer thread row uses the shared `expanded` set; this second set is
  // only for the secondary chevron under it ("Agents (3)" → list). Both
  // default closed; the user clicks each chevron independently. Keyed by
  // thread id.
  const [expandedThreadAgentGroups, setExpandedThreadAgentGroups] = useState<Set<string>>(
    new Set()
  );

  // Persist expansion state across reloads. Stale IDs (containers that
  // have since been deleted) are harmless — they only matter for set
  // membership at render time, and unmatched ids never produce a row.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(expanded)));
    } catch {
      // localStorage quota / disabled — non-fatal, expansion just won't persist.
    }
  }, [expanded]);

  const toggle = (id: string) => {
    const wasExpanded = expanded.has(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      next.add(id);
      // Collapse descendants so expanding a container doesn't recursively
      // reveal whatever was open under it before. Direct children still
      // render, collapsed.
      const node = findNodeInRoots(roots, id);
      if (node) {
        for (const d of collectDescendantIds(node)) next.delete(d);
      }
      return next;
    });
    if (wasExpanded) return;
    const node = findNodeInRoots(roots, id);
    if (!node) return;
    const descendants = collectDescendantIds(node);
    if (descendants.size === 0) return;
    // Mirror the descendant-collapse across the thread-agent-group set so
    // group state inside the subtree also resets to collapsed.
    const dropDescendantKeys = (prev: Set<string>): Set<string> => {
      let next = prev;
      let initialized = false;
      for (const d of descendants) {
        if (prev.has(d)) {
          if (!initialized) {
            next = new Set(prev);
            initialized = true;
          }
          next.delete(d);
        }
      }
      return next;
    };
    setExpandedThreadAgentGroups(dropDescendantKeys);
  };

  const toggleThreadAgentGroup = useCallback((threadId: string) => {
    setExpandedThreadAgentGroups((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, []);

  return {
    expanded,
    setExpanded,
    toggle,
    expandedThreadAgentGroups,
    toggleThreadAgentGroup,
  };
}
