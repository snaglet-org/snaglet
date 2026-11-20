/**
 * candidateCards — compact structured evidence built for search candidates.
 *
 * Cards annotate result presentation and evaluation; they do not change
 * ranking.
 *
 * Hard constraint: card building is batched SQL — a
 * fixed number of queries regardless of candidate count, never a query per
 * candidate. Every lookup below takes `= ANY($ids)` over the whole batch.
 */

import { getDb } from '@snaglet/db';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';

// Card shape (limited to what current data can ground)

type CandidateScopeFit =
  | 'current_thread'
  | 'linked_to_current_thread'
  | 'current_project'
  | 'linked_to_current_project'
  | 'same_container_tree'
  | 'global'
  | 'out_of_scope';

type CandidateLifecycle =
  | 'active'
  | 'backlog'
  | 'queued'
  | 'in_progress'
  | 'blocked'
  | 'complete'
  | 'cancelled'
  | 'archived'
  | 'unknown';

type CandidateFreshnessFit =
  | 'fresh'
  | 'recently_referenced'
  | 'old_but_still_relevant'
  | 'possibly_stale'
  | 'stale'
  | 'unknown';

type CandidateNoveltyFit = 'new_useful_context' | 'duplicate' | 'unknown';

/** Relations come from the links table CHECK constraint. */
interface CandidateLinkEvidence {
  relation: string;
  direction: 'incoming' | 'outgoing';
  linkedNodeId: string;
  linkedNodeKind: string | null;
  createdAt: string | null;
}

export interface CandidateCard {
  id: string;
  kind: string;
  scope: {
    scopeFit: CandidateScopeFit;
    /** Nearest enclosing project of the candidate (or its anchor). */
    projectId: string | null;
    /**
     * The container the scope walk started from: the direct parent of a
     * placed node, or the project container of a thread (and of anything
     * anchored to a thread — messages, summaries, memories).
     */
    containerId: string | null;
    /** Thread the candidate belongs to, when its kind has one. */
    threadId: string | null;
    reason: string;
  };
  status: {
    lifecycle: CandidateLifecycle;
    isArchived: boolean;
    isCompleted: boolean;
    /** thread_summary only: a newer summary version exists. */
    isSuperseded: boolean | null;
    reason: string | null;
  };
  freshness: {
    createdAt: string | null;
    updatedAt: string | null;
    /** Newest link touching this node — someone connected it recently. */
    lastReferencedAt: string | null;
    /** threads.last_message_at of the candidate's thread anchor. */
    lastTalkedAboutAt: string | null;
    dueAt: string | null;
    freshnessFit: CandidateFreshnessFit;
  };
  provenance: {
    sourceThreadId: string | null;
    sourceMessageId: string | null;
    createdByAgentId: string | null;
    createdByUserId: string | null;
    evidenceStrength: 'strong' | 'medium' | 'weak' | 'none';
  };
  links: CandidateLinkEvidence[];
  novelty: {
    alreadyInCurrentPrompt: boolean;
    recentlyReferencedByAgent: boolean;
    novelty: CandidateNoveltyFit;
  };
  scores: {
    rank: number | null;
    score: number | null;
    channels: string[];
  };
  whyRetrieved: string[];
}

/** Minimal structural view of a search hit — no tool-type dependency. */
export interface CardCandidateInput {
  id: string;
  kind: string;
  rank?: number | null;
  score?: number | null;
  channels?: string[] | null;
  /** message / thread_summary hits carry their thread. */
  threadId?: string | null;
  /** memory hits carry their source thread. */
  sourceThreadId?: string | null;
}

export interface CandidateCardContext {
  threadId?: string | null;
  projectId?: string | null;
  containerId?: string | null;
  /** Node ids already visible in the caller's prompt/context. */
  visibleNodeIds?: string[] | null;
  /** Optional node ids already present in the caller's context. */
  recentNodeIds?: string[] | null;
  /** Injectable clock for deterministic tests. */
  now?: number;
}

/** Pull the card-relevant fields out of any SearchHit-shaped object. */
export function toCardCandidate(hit: Record<string, unknown>, rank: number): CardCandidateInput {
  const str = (key: string): string | null => {
    const value = hit[key];
    return typeof value === 'string' && value.trim() ? value : null;
  };
  return {
    id: String(hit.id),
    kind: String(hit.kind),
    rank,
    score: typeof hit.score === 'number' ? hit.score : null,
    channels: Array.isArray(hit.channels) ? (hit.channels as string[]) : null,
    threadId: str('threadId'),
    sourceThreadId: str('sourceThreadId'),
  };
}

// Batched row shapes

interface NodeRow {
  id: string;
  type: string;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  archived: boolean;
  container_id: string | null;
  /** Thread nodes only: the project container the thread is scoped to. */
  project_id: string | null;
}
interface WalkRow {
  seed_id: string;
  container_id: string;
  depth: number;
  category: string | null;
  project_id: string | null;
}
interface LinkRow {
  source_id: string;
  target_id: string;
  relation: string;
  created_at: Date | string | null;
  source_kind: string | null;
  target_kind: string | null;
}
interface SummaryRow {
  id: string;
  thread_id: string;
  agent_id: string | null;
  is_current: boolean;
  last_message_id: string | null;
  created_at: Date | string | null;
}
interface MemoryRow {
  id: string;
  agent_id: string | null;
  source_thread_id: string | null;
  created_at: Date | string | null;
}
interface MessageRow {
  id: string;
  thread_id: string;
  agent_id: string | null;
  user_id: number | null;
  created_at: Date | string | null;
}
interface ThreadRow {
  id: string;
  last_message_at: Date | string | null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Freshness thresholds (days) — deterministic, documented, testable. */
const FRESH_DAYS = 7;
const RECENTLY_REFERENCED_DAYS = 14;
const OLD_BUT_RELEVANT_DAYS = 60;
const POSSIBLY_STALE_DAYS = 180;
/** Per-card cap so link-hub nodes do not flood the card. */
const MAX_LINKS_PER_CARD = 8;

// Build

/**
 * Build cards for a batch of candidates. Returns a map keyed by candidate id.
 * Never throws — a card build failure returns an empty map (cards are
 * evidence, not a dependency of search itself).
 */
export async function buildCandidateCards(
  candidates: CardCandidateInput[],
  context: CandidateCardContext = {}
): Promise<Map<string, CandidateCard>> {
  try {
    return await buildCandidateCardsUnsafe(candidates, context);
  } catch (err) {
    logger.warn(`[candidate-cards] build failed: ${getErrorMessage(err)}`);
    return new Map();
  }
}

async function buildCandidateCardsUnsafe(
  candidates: CardCandidateInput[],
  context: CandidateCardContext
): Promise<Map<string, CandidateCard>> {
  const cards = new Map<string, CandidateCard>();
  if (candidates.length === 0) return cards;
  const db = getDb();
  const now = context.now ?? Date.now();

  const candidateIds = [...new Set(candidates.map((c) => c.id))];
  const kindIds = (kind: string) => [
    ...new Set(candidates.filter((c) => c.kind === kind).map((c) => c.id)),
  ];

  const messageIds = kindIds('message');
  const summaryIds = kindIds('thread_summary');
  const memoryIds = kindIds('memory');

  // -- Per-kind detail rows (each one batched query, only when present) -----
  const [summaryRows, memoryRows, messageRows] = await Promise.all([
    summaryIds.length
      ? db.query<SummaryRow>(
          `SELECT id, thread_id, agent_id, is_current, last_message_id, created_at
             FROM public.thread_summaries WHERE id = ANY($1)`,
          [summaryIds]
        )
      : { rows: [] as SummaryRow[] },
    memoryIds.length
      ? db.query<MemoryRow>(
          `SELECT id, agent_id, source_thread_id, created_at
             FROM public.memories WHERE id = ANY($1)`,
          [memoryIds]
        )
      : { rows: [] as MemoryRow[] },
    messageIds.length
      ? db.query<MessageRow>(
          `SELECT id, thread_id, agent_id, user_id, created_at
             FROM public.messages WHERE id = ANY($1)`,
          [messageIds]
        )
      : { rows: [] as MessageRow[] },
  ]);
  const summaryById = new Map(summaryRows.rows.map((r) => [r.id, r]));
  const memoryById = new Map(memoryRows.rows.map((r) => [r.id, r]));
  const messageById = new Map(messageRows.rows.map((r) => [r.id, r]));

  // -- Anchor resolution ------------------------------------------------------
  // A candidate's placement evidence may live on a different node: messages/
  // summaries/memories anchor to their thread.
  const anchorThreadId = (c: CardCandidateInput): string | null => {
    if (c.kind === 'thread') return c.id;
    if (c.kind === 'message') return c.threadId ?? messageById.get(c.id)?.thread_id ?? null;
    if (c.kind === 'thread_summary') return c.threadId ?? summaryById.get(c.id)?.thread_id ?? null;
    if (c.kind === 'memory')
      return c.sourceThreadId ?? memoryById.get(c.id)?.source_thread_id ?? null;
    return null;
  };

  const threadAnchorIds = [
    ...new Set(
      candidates
        .map(anchorThreadId)
        .concat(context.threadId ? [context.threadId] : [])
        .filter((id): id is string => Boolean(id))
    ),
  ];

  // -- Core batched rows ------------------------------------------------------
  const nodeLookupIds = [...new Set([...candidateIds, ...threadAnchorIds])];
  const [nodeRows, linkRows, threadRows] = await Promise.all([
    db.query<NodeRow>(
      `SELECT id, type::text AS type, created_at, updated_at, archived, container_id, project_id
         FROM public.nodes WHERE id = ANY($1)`,
      [nodeLookupIds]
    ),
    db.query<LinkRow>(
      `SELECT l.source_id, l.target_id, l.relation, l.created_at,
              ns.type::text AS source_kind, nt.type::text AS target_kind
         FROM public.links l
         LEFT JOIN public.nodes ns ON ns.id = l.source_id
         LEFT JOIN public.nodes nt ON nt.id = l.target_id
        WHERE l.source_id = ANY($1) OR l.target_id = ANY($1)
        ORDER BY l.created_at DESC
        LIMIT 500`,
      [candidateIds]
    ),
    threadAnchorIds.length
      ? db.query<ThreadRow>(`SELECT id, last_message_at FROM public.threads WHERE id = ANY($1)`, [
          threadAnchorIds,
        ])
      : { rows: [] as ThreadRow[] },
  ]);
  const nodeById = new Map(nodeRows.rows.map((r) => [r.id, r]));
  const threadById = new Map(threadRows.rows.map((r) => [r.id, r]));

  // -- Container ancestor walk (single recursive CTE for the whole batch) ----
  // Seed: each candidate/anchor's scope container, plus container candidates
  // themselves (a container is "in" its own subtree), plus the context
  // container/thread-project so scope comparison has the same evidence. A
  // placed node's scope container is its parent; a thread's is its project
  // (threads are not in the folder tree), so anything anchored to a thread
  // walks up from that project.
  const walkSeeds = new Set<string>();
  const scopeContainerOf = (id: string | null): string | null => {
    const node = id ? nodeById.get(id) : undefined;
    if (!node) return null;
    return node.type === 'thread' ? node.project_id : node.container_id;
  };
  for (const c of candidates) {
    if (c.kind === 'container') walkSeeds.add(c.id);
    const own = scopeContainerOf(c.id);
    if (own) walkSeeds.add(own);
    const viaThread = scopeContainerOf(anchorThreadId(c));
    if (viaThread) walkSeeds.add(viaThread);
  }
  if (context.containerId) walkSeeds.add(context.containerId);
  const contextThreadProject = scopeContainerOf(context.threadId ?? null);
  if (contextThreadProject) walkSeeds.add(contextThreadProject);

  const walkRowsResult = walkSeeds.size
    ? await db.query<WalkRow>(
        `WITH RECURSIVE walk AS (
           SELECT seed.id AS seed_id, seed.id AS container_id, 0 AS depth
             FROM unnest($1::text[]) AS seed(id)
           UNION ALL
           SELECT w.seed_id, n.container_id, w.depth + 1
             FROM walk w
             JOIN public.nodes n ON n.id = w.container_id
            WHERE n.container_id IS NOT NULL AND w.depth < 32
         )
         SELECT w.seed_id, w.container_id, w.depth,
                c.category AS category,
                CASE WHEN c.category = 'project' AND pn.archived = false
                     THEN pn.id ELSE NULL END AS project_id
           FROM walk w
           LEFT JOIN public.containers c ON c.id = w.container_id
           LEFT JOIN public.nodes pn ON pn.id = w.container_id
          ORDER BY w.seed_id, w.depth ASC`,
        [[...walkSeeds]]
      )
    : { rows: [] as WalkRow[] };

  /**
   * seed container id -> ancestor chain + derived facts. Rows arrive depth-ASC
   * per seed, so the first project container encountered is the nearest one.
   */
  const walkBySeed = new Map<string, { chain: string[]; projectId: string | null }>();
  for (const row of walkRowsResult.rows) {
    const entry = walkBySeed.get(row.seed_id) ?? ({ chain: [], projectId: null } as const);
    const next = {
      chain: [...entry.chain, row.container_id],
      projectId: entry.projectId || row.project_id || null,
    };
    walkBySeed.set(row.seed_id, next);
  }

  // -- Link evidence indexed per candidate ------------------------------------
  const candidateIdSet = new Set(candidateIds);
  const linksByCandidate = new Map<string, CandidateLinkEvidence[]>();
  const pushLink = (id: string, evidence: CandidateLinkEvidence) => {
    const list = linksByCandidate.get(id) ?? [];
    if (list.length < MAX_LINKS_PER_CARD) list.push(evidence);
    linksByCandidate.set(id, list);
  };
  const lastReferencedAt = new Map<string, string | null>();
  for (const row of linkRows.rows) {
    const createdAt = toIso(row.created_at);
    if (candidateIdSet.has(row.source_id)) {
      pushLink(row.source_id, {
        relation: row.relation,
        direction: 'outgoing',
        linkedNodeId: row.target_id,
        linkedNodeKind: row.target_kind,
        createdAt,
      });
      if (!lastReferencedAt.has(row.source_id)) lastReferencedAt.set(row.source_id, createdAt);
    }
    if (candidateIdSet.has(row.target_id)) {
      pushLink(row.target_id, {
        relation: row.relation,
        direction: 'incoming',
        linkedNodeId: row.source_id,
        linkedNodeKind: row.source_kind,
        createdAt,
      });
      if (!lastReferencedAt.has(row.target_id)) lastReferencedAt.set(row.target_id, createdAt);
    }
  }

  // Context project: explicit, or resolved from the context thread's project.
  const contextProjectId =
    context.projectId ??
    (contextThreadProject ? (walkBySeed.get(contextThreadProject)?.projectId ?? null) : null);
  const hasScopeContext = Boolean(context.threadId || contextProjectId || context.containerId);

  const visibleSet = new Set(context.visibleNodeIds ?? []);
  const recentSet = new Set(context.recentNodeIds ?? []);
  const hasNoveltyContext = context.visibleNodeIds != null || context.recentNodeIds != null;

  // -- Assemble one card per candidate ----------------------------------------
  for (const candidate of candidates) {
    if (cards.has(candidate.id)) continue;
    const node = nodeById.get(candidate.id) ?? null;
    const summary = summaryById.get(candidate.id) ?? null;
    const memory = memoryById.get(candidate.id) ?? null;
    const message = messageById.get(candidate.id) ?? null;
    const threadAnchor = anchorThreadId(candidate);
    const links = linksByCandidate.get(candidate.id) ?? [];

    // Scope --------------------------------------------------------------
    const walkStart =
      candidate.kind === 'container'
        ? candidate.id
        : (scopeContainerOf(candidate.id) ?? scopeContainerOf(threadAnchor));
    const walk = walkStart ? (walkBySeed.get(walkStart) ?? null) : null;
    const candidateProjectId = walk?.projectId ?? null;
    const directlyLinkedTo = (targetId: string | null): boolean =>
      Boolean(targetId) && links.some((l) => l.linkedNodeId === targetId);

    let scopeFit: CandidateScopeFit;
    let scopeReason: string;
    if (!hasScopeContext) {
      scopeFit = 'global';
      scopeReason = 'no scope in query — whole workspace';
    } else if (context.threadId && threadAnchor === context.threadId) {
      scopeFit = 'current_thread';
      scopeReason = 'belongs to the current thread';
    } else if (context.threadId && directlyLinkedTo(context.threadId)) {
      scopeFit = 'linked_to_current_thread';
      scopeReason = 'linked to the current thread';
    } else if (contextProjectId && candidateProjectId === contextProjectId) {
      scopeFit = 'current_project';
      scopeReason = 'inside the current project';
    } else if (contextProjectId && directlyLinkedTo(contextProjectId)) {
      scopeFit = 'linked_to_current_project';
      scopeReason = 'linked to the current project';
    } else if (context.containerId && (walk?.chain ?? []).includes(context.containerId)) {
      scopeFit = 'same_container_tree';
      scopeReason = 'inside the scoped container subtree';
    } else if (candidateProjectId && contextProjectId && candidateProjectId !== contextProjectId) {
      scopeFit = 'out_of_scope';
      scopeReason = `belongs to a different project (${candidateProjectId})`;
    } else {
      scopeFit = 'global';
      scopeReason = 'no placement tying it to the current scope';
    }

    // Status ---------------------------------------------------------------
    const isArchived = node?.archived ?? false;
    // Docs carry no task-style lifecycle/completion; only archived/superseded
    // status is derived here.
    const isCompleted = false;
    const isSuperseded = summary ? !summary.is_current : null;
    let lifecycle: CandidateLifecycle;
    let statusReason: string | null = null;
    if (isArchived) {
      lifecycle = 'archived';
      statusReason = 'node is archived';
    } else if (node || summary || memory || message) {
      lifecycle = 'active';
      if (isSuperseded) statusReason = 'superseded by a newer summary of the same thread';
    } else {
      lifecycle = 'unknown';
      statusReason = 'no node row found';
    }

    // Freshness --------------------------------------------------------------
    const createdAt =
      toIso(node?.created_at) ??
      toIso(summary?.created_at) ??
      toIso(memory?.created_at) ??
      toIso(message?.created_at);
    const updatedAt = toIso(node?.updated_at) ?? createdAt;
    const referencedAt = lastReferencedAt.get(candidate.id) ?? null;
    const talkedAboutAt = threadAnchor
      ? toIso(threadById.get(threadAnchor)?.last_message_at)
      : null;

    const activityCandidates = [updatedAt, talkedAboutAt]
      .filter((t): t is string => Boolean(t))
      .map((t) => new Date(t).getTime());
    const lastActivity = activityCandidates.length ? Math.max(...activityCandidates) : null;
    const ageDays = lastActivity != null ? (now - lastActivity) / DAY_MS : null;
    const referencedDays = referencedAt ? (now - new Date(referencedAt).getTime()) / DAY_MS : null;

    let freshnessFit: CandidateFreshnessFit;
    if (isArchived || isSuperseded) freshnessFit = 'stale';
    else if (ageDays == null) freshnessFit = 'unknown';
    else if (ageDays <= FRESH_DAYS) freshnessFit = 'fresh';
    else if (referencedDays != null && referencedDays <= RECENTLY_REFERENCED_DAYS)
      freshnessFit = 'recently_referenced';
    else if (ageDays <= OLD_BUT_RELEVANT_DAYS) freshnessFit = 'old_but_still_relevant';
    else if (ageDays <= POSSIBLY_STALE_DAYS) freshnessFit = 'possibly_stale';
    else freshnessFit = 'stale';

    // Provenance --------------------------------------------------------------
    const sourceThreadId =
      memory?.source_thread_id ?? summary?.thread_id ?? message?.thread_id ?? null;
    const sourceMessageId = summary?.last_message_id ?? null;
    const createdByAgentId = memory?.agent_id ?? summary?.agent_id ?? message?.agent_id ?? null;
    const createdByUserId = message?.user_id != null ? String(message.user_id) : null;
    const evidenceStrength: CandidateCard['provenance']['evidenceStrength'] = sourceThreadId
      ? 'strong'
      : links.length > 0
        ? 'medium'
        : createdByAgentId || createdByUserId
          ? 'weak'
          : 'none';

    // Novelty --------------------------------------------------------------
    const alreadyInCurrentPrompt = visibleSet.has(candidate.id);
    const recentlyReferencedByAgent = recentSet.has(candidate.id);
    const novelty: CandidateNoveltyFit = !hasNoveltyContext
      ? 'unknown'
      : alreadyInCurrentPrompt
        ? 'duplicate'
        : 'new_useful_context';

    // Why retrieved --------------------------------------------------------
    const channels = candidate.channels ?? [];
    const whyRetrieved: string[] = [];
    if (channels.includes('vector')) whyRetrieved.push('semantic similarity match');
    if (channels.includes('fts')) whyRetrieved.push('keyword match');
    if (channels.includes('graph')) whyRetrieved.push('linked to another matched node');
    if (channels.includes('fuzzy')) whyRetrieved.push('fuzzy name match');
    if (channels.includes('structured')) whyRetrieved.push('structured lifecycle match');
    if (channels.length === 0) whyRetrieved.push('matched by the current pipeline');
    if (scopeFit === 'current_thread' || scopeFit === 'current_project')
      whyRetrieved.push(scopeReason);
    if (freshnessFit === 'fresh' && ageDays != null)
      whyRetrieved.push(`active ${Math.max(0, Math.round(ageDays))}d ago`);
    if (links.length > 0) whyRetrieved.push(`${links.length} link(s) in the workspace graph`);

    cards.set(candidate.id, {
      id: candidate.id,
      kind: candidate.kind,
      scope: {
        scopeFit,
        projectId: candidateProjectId,
        containerId: walkStart ?? null,
        threadId: threadAnchor,
        reason: scopeReason,
      },
      status: {
        lifecycle,
        isArchived,
        isCompleted,
        isSuperseded,
        reason: statusReason,
      },
      freshness: {
        createdAt,
        updatedAt,
        lastReferencedAt: referencedAt,
        lastTalkedAboutAt: talkedAboutAt,
        dueAt: null,
        freshnessFit,
      },
      provenance: {
        sourceThreadId,
        sourceMessageId,
        createdByAgentId,
        createdByUserId,
        evidenceStrength,
      },
      links,
      novelty: { alreadyInCurrentPrompt, recentlyReferencedByAgent, novelty },
      scores: {
        rank: candidate.rank ?? null,
        score: candidate.score ?? null,
        channels,
      },
      whyRetrieved,
    });
  }

  return cards;
}
