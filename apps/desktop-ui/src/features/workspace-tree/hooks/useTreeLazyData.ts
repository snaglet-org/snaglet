import { useCallback, useEffect, useRef, useState } from 'react';
import { agentsApi, filesApi, type FileRecord, type LibraryTreeChild } from '../../../utils/api';
import { threadsApi } from '../../../utils/api/threads';
import type { ThreadAgentEntry } from '../types';

export interface UseTreeLazyDataArgs {
  /** Loaded tree roots — drives the expanded-node backfill walks. */
  roots: LibraryTreeChild[] | null;
  /** Currently-expanded node ids — gates which threads/projects fetch. */
  expanded: Set<string>;
  /**
   * Tree refetch key — a change wipes both caches for a fresh backfill. The
   * tree passes the `loadedReloadKey` of `useWorkspaceTreeRoots`, which
   * moves with the refetched tree itself (once per landed refetch, not once
   * per invalidation event), so the backfill walks the new roots.
   */
  reloadKey: number;
}

/**
 * Lazy per-node child data for expanded tree rows: a per-project indexed-file
 * cache (project-home rows reveal their files, paged via filesApi) and a
 * per-thread participant cache (joined client-side with the full agents
 * roster so each row gets a display name + role without an N+1 fetch).
 * Both caches use a `null` sentinel while a fetch is in flight, dedupe
 * concurrent requests through ref-tracked in-flight sets, fall back to an
 * empty list on failure rather than pinning a spinner, are wiped whenever
 * the tree refetches, and are filled for every expanded project and thread
 * however it came to be open — a chevron, a key, a reveal, a create flow, or
 * the expansion restored from localStorage.
 */
export function useTreeLazyData({ roots, expanded, reloadKey }: UseTreeLazyDataArgs) {
  // Per-thread participant cache. Lazy load triggered when a thread row is
  // expanded, `null` sentinel during the in-flight fetch so the row can
  // render "Loading agents…" without a flash. Joined with the full agents
  // roster client-side to surface each participant's display name + role
  // inline. Cleared on tree refetch so a refresh re-fetches whatever threads
  // are currently open.
  const [threadAgents, setThreadAgents] = useState<
    Map<string, { entries: ThreadAgentEntry[] } | null>
  >(() => new Map());
  const inflightThreadAgentsRef = useRef<Set<string>>(new Set());
  const loadThreadAgents = useCallback(async (threadId: string) => {
    if (inflightThreadAgentsRef.current.has(threadId)) return;
    inflightThreadAgentsRef.current.add(threadId);
    setThreadAgents((prev) => {
      if (prev.has(threadId)) return prev;
      const next = new Map(prev);
      next.set(threadId, null);
      return next;
    });
    try {
      // Parallel: participants + the full agent roster. We do the join
      // client-side so we get name/role on each row without an N+1 fetch.
      const [participants, agents] = await Promise.all([
        threadsApi.listParticipants(threadId),
        agentsApi.list(),
      ]);
      const byId = new Map(agents.map((a) => [a.id, a]));
      const entries: ThreadAgentEntry[] = participants.map((p) => ({
        participant: p,
        agent: byId.get(p.agentId) ?? null,
      }));
      setThreadAgents((prev) => {
        const next = new Map(prev);
        next.set(threadId, { entries });
        return next;
      });
    } catch {
      // Render as empty rather than leaving the loading sentinel pinned —
      // the chevron's already in the open state, and we'd rather show
      // "no agents" than a permanent spinner on a transient failure.
      setThreadAgents((prev) => {
        const next = new Map(prev);
        next.set(threadId, { entries: [] });
        return next;
      });
    } finally {
      inflightThreadAgentsRef.current.delete(threadId);
    }
  }, []);

  // Project-home rows reveal their indexed file tree. Same lazy/cached/sentinel
  // shape as threadAgents: keyed by project id (the container id), `null`
  // while in-flight, fetched only on expand. The server resolves folder
  // ownership, so a satellite project gets its subtree of the owner's index.
  const [projectFiles, setProjectFiles] = useState<Map<string, FileRecord[] | null>>(
    () => new Map()
  );
  const inflightFilesRef = useRef<Set<string>>(new Set());

  const loadProjectFiles = useCallback(async (projectId: string) => {
    if (inflightFilesRef.current.has(projectId)) return;
    inflightFilesRef.current.add(projectId);
    setProjectFiles((prev) => {
      if (prev.has(projectId)) return prev;
      const next = new Map(prev);
      next.set(projectId, null);
      return next;
    });
    try {
      const files = await filesApi.listByProject(projectId);
      setProjectFiles((prev) => {
        const next = new Map(prev);
        next.set(projectId, files);
        return next;
      });
    } catch {
      // Render as empty rather than pinning the loading sentinel.
      setProjectFiles((prev) => {
        const next = new Map(prev);
        next.set(projectId, []);
        return next;
      });
    } finally {
      inflightFilesRef.current.delete(projectId);
    }
  }, []);

  // Tree refetches drop the per-project / per-thread caches so the next
  // backfill pass re-fetches them fresh. Triggered by reloadKey only, which
  // moves in the same render as the refetched roots; the actual
  // walk-and-fetch happens in the effect below against that new tree.
  useEffect(() => {
    setProjectFiles(new Map());
    inflightFilesRef.current = new Set();
    setThreadAgents(new Map());
    inflightThreadAgentsRef.current = new Set();
  }, [reloadKey]);

  // Fetch for every expanded project (its files; the project id is the
  // container id) and thread (its participants) not cached yet. Watching
  // `expanded` covers a project a reveal or a create flow opened, which no
  // chevron click announced; watching `roots` covers the expansion restored
  // from localStorage once the tree first loads. Both loaders are idempotent
  // against their in-flight refs and cache checks, so re-walks are no-ops
  // for ids already loaded or loading.
  useEffect(() => {
    if (!roots) return;
    const walk = (nodes: LibraryTreeChild[]) => {
      for (const n of nodes) {
        if (!expanded.has(n.id)) {
          if (n.kind === 'container') walk(n.children ?? []);
          continue;
        }
        if (n.kind === 'thread' && !threadAgents.has(n.id)) void loadThreadAgents(n.id);
        if (n.kind === 'container') {
          if (n.category === 'project' && !projectFiles.has(n.id)) void loadProjectFiles(n.id);
          walk(n.children ?? []);
        }
      }
    };
    walk(roots);
  }, [roots, expanded, projectFiles, threadAgents, loadProjectFiles, loadThreadAgents]);

  return { projectFiles, threadAgents };
}
