/**
 * Recursive copy/paste of workspace-tree nodes (the tree's Cmd/Ctrl+C, V) with
 * fresh ids. Docs copy verbatim (a `(n)` suffix on a title clash); containers
 * copy their subtree, and a project also takes its threads; threads copy
 * config only (title, dispatch config, prompts and overrides, participants),
 * never messages, memories or summaries. Agents are never cloned. Links and
 * transclusions inside the copied subtree point at the clones, and no copy may
 * close a transclusion loop. Every row is written in one transaction; realtime
 * events and embedding enqueue run after commit.
 * MAX_CLONE_NODES caps the size so a huge subtree fails fast.
 */

import { generateId, AppError } from '@snaglet/shared/utils';
import { HTTP_STATUS, ErrorCode } from '@snaglet/shared/types';
import {
  assertNoTransclusionLoop,
  Nodes,
  Docs,
  Containers,
  Projects,
  Threads,
  ThreadParticipants,
  transaction,
  currentActorMemberId,
  getDb,
} from '@snaglet/db';
import type { DocRow } from '@snaglet/db/tables/docs';
import type { ContainerRow } from '@snaglet/db/tables/containers';
import type { ThreadRow } from '@snaglet/db/tables/threads';
import type { ThreadParticipantRow } from '@snaglet/db/tables/thread_participants';
import type { WorkspaceNodeSnapshot } from '@snaglet/shared/types/workspace-events';
import { remapNodeRefs } from '@server/services/WorkspaceService/markdownRefs';
import { syncContentRefLinks } from '@server/services/contentRefs';
import { embedDocNow } from '@server/services/embedding/embedDoc';
import {
  emitTreeNodeCreated,
  snapshotFromDoc,
  snapshotFromContainer,
  snapshotFromThread,
} from '@server/realtime/surfaces/tree';
import { logger } from '@server/config/logger';

/**
 * Hard ceiling on the number of nodes a single paste may create. A copy is
 * cycle-impossible (every cloned node gets a new id), so this is purely a
 * blast-radius guard against pasting an enormous subtree in one transaction.
 */
export const MAX_CLONE_NODES = 200;

/** Kinds the clone recurses into / reproduces. Other node kinds under a
 *  container (image, file, …) are intentionally skipped. */
type CloneKind = 'container' | 'doc' | 'thread';

/** Any source row the clone can start from or discover under a container. */
type SourceRow = DocRow | ContainerRow | ThreadRow;

export interface CloneNodeInput {
  /** Id of the node to copy (doc / container / thread). */
  sourceId: string;
  /**
   * Where to paste. `undefined` → the source node's own parent (paste beside
   * the original); `null` → workspace root; a string → that container id.
   * For a thread the parent is its project: a project container id, or null
   * for a flat thread.
   */
  targetContainerId?: string | null;
  /** Explicit position under the target; omitted → appended to the end. Inert for threads. */
  sortOrder?: number;
  /** Allow an archived node to be a copy source (default false). */
  allowArchived?: boolean;
  /**
   * Base title for the top-level clone, overriding the source's own title.
   * Still runs through the ` (n)` collision suffixer against the target's
   * siblings. Omitted → the source's title is used (default copy/paste
   * behavior). Used by `duplicate_doc` so a single doc can be cloned with a
   * caller-chosen title while still going through this one clone engine.
   */
  titleOverride?: string;
}

export interface CloneNodeResult {
  /** Snapshot of the new top-level (pasted) node. */
  root: WorkspaceNodeSnapshot;
  /** Total number of nodes created (root + every cloned descendant). */
  count: number;
}

/** One discovered source node paired with its clone's placement + data. */
interface Discovered {
  kind: CloneKind;
  oldId: string;
  newId: string;
  newParentId: string | null;
  sortOrder: number;
  /** Only the top-level node may be re-titled (collision suffix). */
  titleOverride: string | null;
  container?: ContainerRow;
  doc?: DocRow;
  contentRemapped?: string;
  thread?: ThreadRow;
  participants?: ThreadParticipantRow[];
}

function isArchived(row: { archived?: boolean | null }): boolean {
  return row.archived === true;
}

/** Generate a node id that is unique within this clone operation. */
function freshId(kind: CloneKind, used: Set<string>): string {
  let id = generateId(kind);
  while (used.has(id)) id = generateId(kind);
  used.add(id);
  return id;
}

/** MAX(sort_order)+1 for a kind within a container bucket (mirrors the models'
 *  resolveSortOrder append semantics). NULL container = its own root bucket.
 *  A thread copy is a new thread, so it starts at the top of its project's
 *  list (slot 0; the write phase shifts the rest down). */
async function nextSortOrder(kind: CloneKind, containerId: string | null): Promise<number> {
  if (kind === 'thread') return 0;
  const { rows } = await getDb().query<{ next: number }>(
    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next
       FROM public.nodes
      WHERE type = $1 AND container_id IS NOT DISTINCT FROM $2`,
    [kind, containerId]
  );
  return rows[0]?.next ?? 1;
}

/**
 * Resolve a non-colliding title for the top-level pasted node against the
 * active same-kind siblings already in the target container. Appends
 * ` (1)`, ` (2)`, … until free. A null/empty base (e.g. an untitled thread)
 * is returned unchanged — nothing to collide.
 */
async function resolveCollisionTitle(
  kind: CloneKind,
  base: string | null,
  targetContainerId: string | null
): Promise<string | null> {
  if (base == null || base.trim() === '') return base;
  const existing = await siblingTitles(kind, targetContainerId);
  const taken = new Set(existing.map((t) => t.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 1; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Active same-kind sibling titles/names in a container bucket (for a thread, its project's threads). */
async function siblingTitles(kind: CloneKind, containerId: string | null): Promise<string[]> {
  if (kind === 'doc') {
    return (await Docs.listByContainer(containerId))
      .filter((d) => !isArchived(d))
      .map((d) => d.title);
  }
  if (kind === 'container') {
    return (await Containers.listByParent(containerId))
      .filter((c) => !isArchived(c))
      .map((c) => c.name);
  }
  // listByProject already excludes archived rows.
  return (await Threads.listByProject(containerId))
    .map((t) => t.title ?? '')
    .filter((t) => t !== '');
}

/**
 * Breadth-first discovery of the whole source subtree. Assigns every node a
 * fresh id up-front (so idMap is complete before doc content is remapped) and
 * enforces MAX_CLONE_NODES. Parents precede children in the returned list, so
 * the write phase can insert node rows in-order without FK violations.
 */
async function discoverSubtree(
  root: { kind: CloneKind; row: SourceRow },
  rootPlacement: { newParentId: string | null; sortOrder: number; titleOverride: string | null },
  maxNodes: number
): Promise<{ discovered: Discovered[]; idMap: Map<string, string> }> {
  const discovered: Discovered[] = [];
  const idMap = new Map<string, string>();
  const usedIds = new Set<string>();

  interface QueueItem {
    kind: CloneKind;
    row: SourceRow;
    newParentId: string | null;
    sortOrder: number;
    titleOverride: string | null;
  }

  const queue: QueueItem[] = [
    {
      kind: root.kind,
      row: root.row,
      newParentId: rootPlacement.newParentId,
      sortOrder: rootPlacement.sortOrder,
      titleOverride: rootPlacement.titleOverride,
    },
  ];

  let count = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    count += 1;
    if (count > maxNodes) {
      throw new AppError(
        `Cannot copy: subtree exceeds the ${maxNodes}-node paste limit.`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const newId = freshId(cur.kind, usedIds);
    idMap.set(cur.row.id, newId);

    const entry: Discovered = {
      kind: cur.kind,
      oldId: cur.row.id,
      newId,
      newParentId: cur.newParentId,
      sortOrder: cur.sortOrder,
      titleOverride: cur.titleOverride,
    };

    if (cur.kind === 'container') {
      const container = cur.row as ContainerRow;
      entry.container = container;
      // Enumerate active children (archived nodes are not copy sources). Only
      // a project has threads: those scoped to it by project_id.
      const [childContainers, childDocs, childThreads] = await Promise.all([
        Containers.listByParent(container.id),
        Docs.listByContainer(container.id),
        container.category === 'project' ? Threads.listByProject(container.id) : [],
      ]);
      for (const c of childContainers) {
        if (isArchived(c)) continue;
        queue.push({
          kind: 'container',
          row: c,
          newParentId: newId,
          sortOrder: c.sortOrder,
          titleOverride: null,
        });
      }
      for (const d of childDocs) {
        if (isArchived(d)) continue;
        queue.push({
          kind: 'doc',
          row: d,
          newParentId: newId,
          sortOrder: d.sortOrder,
          titleOverride: null,
        });
      }
      for (const t of childThreads) {
        if (isArchived(t)) continue;
        queue.push({
          kind: 'thread',
          row: t,
          newParentId: newId,
          sortOrder: t.sortOrder,
          titleOverride: null,
        });
      }
    } else if (cur.kind === 'doc') {
      entry.doc = cur.row as DocRow;
    } else {
      const thread = cur.row as ThreadRow;
      entry.thread = thread;
      entry.participants = await ThreadParticipants.listByThread(thread.id);
    }

    discovered.push(entry);
  }

  // Second pass: remap node references now that idMap covers the whole subtree.
  for (const entry of discovered) {
    if (entry.kind === 'doc' && entry.doc) {
      entry.contentRemapped = remapNodeRefs(entry.doc.content ?? '', idMap);
    }
  }

  return { discovered, idMap };
}

/** Load the source node's row + kind, or null if it is not a cloneable node. */
async function loadSource(sourceId: string): Promise<{ kind: CloneKind; row: SourceRow } | null> {
  const type = await Nodes.getType(sourceId);
  if (type === 'doc') {
    const row = await Docs.findById(sourceId);
    return row ? { kind: 'doc', row } : null;
  }
  if (type === 'container') {
    const row = await Containers.findById(sourceId);
    return row ? { kind: 'container', row } : null;
  }
  if (type === 'thread') {
    const row = await Threads.findById(sourceId);
    return row ? { kind: 'thread', row } : null;
  }
  return null;
}

/** Placement parent of a source row, by kind (a thread's parent is its project). */
function parentOf(kind: CloneKind, row: SourceRow): string | null {
  if (kind === 'container') return (row as ContainerRow).parentId;
  if (kind === 'thread') return (row as ThreadRow).projectId;
  return (row as DocRow).containerId;
}

/** Title/name of a source row, by kind. */
function titleOf(kind: CloneKind, row: SourceRow): string | null {
  if (kind === 'container') return (row as ContainerRow).name;
  if (kind === 'doc') return (row as DocRow).title;
  return (row as ThreadRow).title;
}

/** Internal knobs — the HTTP path always uses defaults; tests override the cap. */
export interface CloneNodeOptions {
  /** Recursion ceiling (default MAX_CLONE_NODES). Test seam. */
  maxNodes?: number;
}

/**
 * Clone a node (and, for containers, its whole subtree) into a target
 * container. See the file header for per-kind semantics.
 */
export async function cloneNode(
  input: CloneNodeInput,
  options?: CloneNodeOptions
): Promise<CloneNodeResult> {
  const maxNodes = options?.maxNodes ?? MAX_CLONE_NODES;
  const source = await loadSource(input.sourceId);
  if (!source) {
    throw new AppError(
      `Node not found or not copyable: ${input.sourceId}`,
      ErrorCode.NOT_FOUND,
      HTTP_STATUS.NOT_FOUND
    );
  }
  // A DM thread is a private two-party conversation: a copy would be an
  // empty chat thread (the copy writes explicit columns), so refuse instead.
  if (source.kind === 'thread' && (source.row as ThreadRow).kind === 'dm') {
    throw new AppError(
      `Node ${input.sourceId} is a direct message thread and cannot be copied.`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  if (isArchived(source.row) && !input.allowArchived) {
    throw new AppError(
      `Node ${input.sourceId} is archived and cannot be copied. Restore it first, or pass allowArchived.`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }

  // Resolve the paste target: explicit value wins; undefined → source's parent.
  const targetContainerId =
    input.targetContainerId !== undefined
      ? input.targetContainerId
      : parentOf(source.kind, source.row);

  if (source.kind === 'thread') {
    // A thread's paste target is a project scope: a live project container
    // (404 unknown, 400 for a non-project or archived project) or null.
    await Projects.assertProjectContainer(targetContainerId);
  } else if (targetContainerId !== null) {
    const target = await Containers.findById(targetContainerId);
    if (!target) {
      throw new AppError(
        `Target container not found: ${targetContainerId}`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    if (isArchived(target)) {
      throw new AppError(
        `Target container ${targetContainerId} is archived.`,
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
  }

  // Top-level placement: append (or use the explicit slot) + collision suffix.
  const rootSortOrder =
    input.sortOrder !== undefined
      ? input.sortOrder
      : await nextSortOrder(source.kind, targetContainerId);
  const rootTitle = await resolveCollisionTitle(
    source.kind,
    input.titleOverride ?? titleOf(source.kind, source.row),
    targetContainerId
  );

  const { discovered } = await discoverSubtree(
    source,
    {
      newParentId: targetContainerId,
      sortOrder: rootSortOrder,
      titleOverride: rootTitle,
    },
    maxNodes
  );

  const createdBy = await currentActorMemberId();

  // Write phase: one transaction, rolled back on any failure.
  await transaction(async (tx) => {
    // 1. Every placed nodes-spine row first, in BFS order (parents before
    //    children), so both the container_id FK and the doc-link trigger's
    //    target-exists check are satisfied when the type rows land below.
    //    Thread nodes wait for step 3: they are scoped by project_id, and the
    //    scope guard needs the cloned project's containers row to exist.
    for (const d of discovered) {
      if (d.kind === 'thread') continue;
      await tx.query(
        `INSERT INTO public.nodes (id, type, container_id, sort_order) VALUES ($1, $2, $3, $4)`,
        [d.newId, d.kind, d.newParentId, d.sortOrder]
      );
    }

    // 2. Containers. Project facets (folder_path, github_url,
    //    file_indexing_enabled) are not cloned: a cloned project has no folder
    //    of its own rather than a second row pointing at the original's.
    for (const d of discovered) {
      if (d.kind !== 'container' || !d.container) continue;
      const c = d.container;
      await tx.query(
        `INSERT INTO public.containers (id, name, category, description, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [d.newId, d.titleOverride ?? c.name, c.category, c.description, createdBy]
      );
    }

    // 3. Threads (config-only) + their participant set. No messages / memories
    //    / summaries — a fresh empty thread with the same shape. The spine row
    //    carries the project scope and never a container. A copied thread
    //    makes room at its slot in the target project's list; threads copied
    //    along with their project keep their source order in the new one.
    for (const d of discovered) {
      if (d.kind !== 'thread' || !d.thread) continue;
      const t = d.thread;
      if (d.oldId === source.row.id) await Threads.openSlot(d.newParentId, d.sortOrder, tx);
      await tx.query(
        `INSERT INTO public.nodes (id, type, project_id, sort_order) VALUES ($1, 'thread', $2, $3)`,
        [d.newId, d.newParentId, d.sortOrder]
      );
      await tx.query(
        `INSERT INTO public.threads
           (id, title, dispatch_mode, thread_system_prompt,
            max_waves, max_total_output_tokens, max_agent_dispatches,
            tool_access_mode, tool_access_allow_list, tool_access_deny_list)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
        [
          d.newId,
          d.titleOverride !== null ? d.titleOverride : t.title,
          t.dispatchMode,
          t.threadSystemPrompt,
          t.maxWaves,
          t.maxTotalOutputTokens,
          t.maxAgentDispatches,
          t.toolAccessMode,
          t.toolAccessAllowList == null ? null : JSON.stringify(t.toolAccessAllowList),
          t.toolAccessDenyList == null ? null : JSON.stringify(t.toolAccessDenyList),
        ]
      );
      for (const p of d.participants ?? []) {
        // Column set mirrors ThreadParticipants.addParticipant — the canonical
        // participant-creation path. id / created_at / updated_at default.
        await tx.query(
          `INSERT INTO public.thread_participants
             (thread_id, member_id, credential_id, provider_id, model_id, system_prompt_addendum,
              tool_access_mode, tool_access_allow_list, tool_access_deny_list, tool_overrides,
              max_tool_calls_per_turn, max_duration_seconds, auto_respond)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13)`,
          [
            d.newId,
            p.memberId,
            p.credentialId,
            p.providerId,
            p.modelId,
            p.systemPromptAddendum,
            p.toolAccessMode,
            p.toolAccessAllowList == null ? null : JSON.stringify(p.toolAccessAllowList),
            p.toolAccessDenyList == null ? null : JSON.stringify(p.toolAccessDenyList),
            p.toolOverrides == null ? null : JSON.stringify(p.toolOverrides),
            p.maxToolCallsPerTurn,
            p.maxDurationSeconds,
            p.autoRespond,
          ]
        );
      }
    }

    // 4. Docs last — every node id now exists, so the doc-link INSERT trigger
    //    resolves intra-subtree refs (already remapped in `contentRemapped`) to
    //    the cloned counterparts and drops refs to still-missing targets.
    for (const d of discovered) {
      if (d.kind !== 'doc' || !d.doc) continue;
      const doc = d.doc;
      await tx.query(
        `INSERT INTO public.docs (id, title, content, due_at, assigned_to, priority, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          d.newId,
          d.titleOverride ?? doc.title,
          d.contentRemapped ?? '',
          doc.dueAt,
          doc.assignedTo,
          doc.priority,
          createdBy,
        ]
      );
    }
    // With every copy written, a copy may not close a transclusion loop
    // (copying docs that already loop would loop again among the copies).
    for (const d of discovered) {
      if (d.kind !== 'doc' || !d.doc) continue;
      await assertNoTransclusionLoop(tx, {
        id: d.newId,
        title: d.titleOverride ?? d.doc.title,
        content: d.contentRemapped ?? '',
        previous: null,
      });
    }
  });

  // After commit: realtime tree events, link graph and embeddings.
  const now = new Date().toISOString();
  let rootSnapshot: WorkspaceNodeSnapshot | null = null;
  for (const d of discovered) {
    const snap = buildSnapshot(d, now);
    emitTreeNodeCreated(snap);
    if (d.oldId === source.row.id) rootSnapshot = snap;
    if (d.kind === 'doc') {
      // Match the doc-create route: reconcile the link graph (covers bare-id
      // refs the SQL trigger misses) and enqueue an immediate embed.
      syncContentRefLinks(d.newId, d.contentRemapped ?? null);
      embedDocNow(d.newId, d.titleOverride ?? d.doc!.title, d.contentRemapped ?? '');
    }
  }

  logger.info(
    `[clone] copied ${source.kind} ${source.row.id} → ${rootSnapshot?.id} (${discovered.length} node(s))`
  );

  // rootSnapshot is always set — the source row is the first discovered entry.
  return { root: rootSnapshot!, count: discovered.length };
}

/** Build the realtime `workspace.created` snapshot for a cloned node. */
function buildSnapshot(d: Discovered, now: string): WorkspaceNodeSnapshot {
  if (d.kind === 'doc') {
    return snapshotFromDoc({
      id: d.newId,
      containerId: d.newParentId,
      title: d.titleOverride ?? d.doc!.title,
      sortOrder: d.sortOrder,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (d.kind === 'container') {
    const c = d.container!;
    return snapshotFromContainer({
      id: d.newId,
      parentId: d.newParentId,
      name: d.titleOverride ?? c.name,
      category: c.category,
      sortOrder: d.sortOrder,
      createdAt: now,
      updatedAt: now,
    });
  }
  return snapshotFromThread({
    id: d.newId,
    title: d.titleOverride !== null ? d.titleOverride : d.thread!.title,
    projectId: d.newParentId,
    sortOrder: d.sortOrder,
    createdAt: now,
    updatedAt: now,
  });
}
