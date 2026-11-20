/**
 * MemoryService — high-level memory operations (store, recall, forget).
 *
 * Deliberately minimal: no `tags`, `memoryType`, `importance`, or
 * `sourceMessageId`. Forget is hard-delete only (no soft-delete tombstones, no
 * tag-based bulk delete; bulk forget is query-based).
 *
 * Ownership: every input carries its owner as a flat `agentId?` or
 * `memberId?` field (member/user-owned records) — never both, never neither.
 * Kept flat so the agent-run call shape (`{ agentId, threadId, ... }`) stays
 * simple; `toOwnerRef` is the one place that turns it into the `OwnerRef` the
 * Model layer's owner-scoped queries expect (@snaglet/db/ownerRef).
 */

import { Memories } from '@snaglet/db/tables/memories';
import { Embeddings } from '@snaglet/db/tables/embeddings';
import { Links } from '@snaglet/db/tables/links';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import type {
  MemoryDetailRow,
  MemoryRow,
  MemoryStatus,
  UpdateMemoryInput,
  MemorySearchResult,
} from '@snaglet/db/tables/memories';
import { ownerId, type OwnerRef } from '@snaglet/db/ownerRef';
import { generateDocumentEmbedding, generateQueryEmbedding } from './EmbeddingService';
import { clampInt, generateId, getErrorMessage, isoNow } from '@snaglet/shared/utils';
import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';
import { logger } from '@server/config/logger';

export interface StoreMemoryInput {
  agentId?: string;
  memberId?: string;
  threadId?: string;
  key: string;
  content: string;
  /**
   * Trust. Defaults to true here — an explicit `store` call (the
   * memory tool's create op, a member saving their own note) is a deliberate act.
   * Compaction-time extraction passes false: machine-written, unreviewed.
   */
  verified?: boolean;
  /**
   * Lifecycle. Defaults to 'active'. Extraction stores member-scoped
   * facts as 'proposed': inert, excluded from recall, awaiting explicit human
   * approval. A proposed store never overwrites an existing active memory —
   * see the upsert path below.
   */
  status?: MemoryStatus;
}

export interface RecallMemoryInput {
  agentId?: string;
  memberId?: string;
  threadId?: string;
  query: string;
  limit?: number;
  /**
   * Auto-recall only (memoryRecallSegment): restrict candidates to memories
   * whose source thread is in one of these projects, plus agent-global ones
   * (no / flat source thread). Omitted = unscoped — the explicit `memory`
   * recall tool never passes it.
   */
  projectScope?: { allowedProjectIds: string[] };
  /**
   * An agent's recall in a thread with one human: also search that member's
   * kept memories (facts about them they approved), in the same candidate
   * pool. Not an owner: the agent stays the owner (`agentId`).
   */
  alsoMemberId?: string | null;
}

export interface ForgetMemoryInput {
  agentId?: string;
  memberId?: string;
  memoryId?: string;
  query?: string;
}

/**
 * How an edit changes a memory's content. `find`/`replaceWith` are LITERAL
 * strings, never regex sources — see `applyMemoryEdit`.
 */
export type MemoryEdit =
  | { mode: 'overwrite'; content: string }
  | { mode: 'append'; content: string; separator?: string }
  | { mode: 'replace'; find: string; replaceWith: string; all?: boolean };

export interface EditMemoryInput {
  agentId?: string;
  memberId?: string;
  /** Exactly one of memoryId/key — see `toEditTarget`. */
  memoryId?: string;
  key?: string;
  edit: MemoryEdit;
}

/**
 * Outcome of an edit. Everything the caller must be able to tell apart is a
 * status, not an exception: `not_found` covers both "no such memory" and
 * "someone else's memory" (deliberately indistinguishable, as in `forget`),
 * `find_absent` is a typo'd `find` that must fail loudly rather than no-op,
 * and `would_blank` is an edit that would empty the memory (that's `forget`'s
 * job, not an edit's).
 */
export type EditMemoryResult =
  | { status: 'updated'; id: string; key: string | null; content: string }
  | { status: 'not_found' }
  | { status: 'find_absent' }
  | { status: 'would_blank' };

type EditTarget = { by: 'id'; memoryId: string } | { by: 'key'; key: string };

const MAX_RECALL_LIMIT = 50;
const DEFAULT_APPEND_SEPARATOR = '\n';

function logBestEffortFailure(operation: string): (error: unknown) => void {
  return (error) => logger.debug(`[MemoryService] ${operation} failed: ${getErrorMessage(error)}`);
}

/**
 * Normalize a flat { agentId?, memberId? } input into the OwnerRef the Model
 * layer expects. Defensive, not decorative: the tool layer (ToolValidation's
 * resolveMemoryOwner) always resolves exactly one before calling in, but a
 * direct MemoryService caller (tests, scripts, future callers) could pass
 * neither or both — fail loudly rather than silently picking one.
 */
function toOwnerRef(input: { agentId?: string; memberId?: string }, fnName: string): OwnerRef {
  if (input.agentId && input.memberId) {
    throw new Error(`${fnName}: owner must be exactly one of agentId/memberId, got both`);
  }
  if (input.agentId) return { agentId: input.agentId };
  if (input.memberId) return { memberId: input.memberId };
  throw new Error(`${fnName}: owner (agentId or memberId) is required`);
}

/**
 * Same exactly-one discipline as `toOwnerRef`, applied to WHICH memory an edit
 * targets. Both/neither is a caller bug, not a fallback to guess at.
 */
function toEditTarget(input: { memoryId?: string; key?: string }, fnName: string): EditTarget {
  if (input.memoryId && input.key) {
    throw new Error(`${fnName}: target must be exactly one of memoryId/key, got both`);
  }
  if (input.memoryId) return { by: 'id', memoryId: input.memoryId };
  if (input.key) return { by: 'key', key: input.key };
  throw new Error(`${fnName}: target (memoryId or key) is required`);
}

/**
 * Pure content transform — no I/O, no ownership concerns. Split out so the
 * mode semantics are testable on their own and obvious to read.
 *
 * `replace` stays LITERAL in both directions: the replacement is passed as a
 * function (or joined from a split) so `$&`, `$1`, `$'` in `replaceWith` are
 * inserted verbatim instead of being interpreted by String.replace's
 * substitution syntax.
 */
function applyMemoryEdit(
  current: string,
  edit: MemoryEdit
): { ok: true; content: string } | { ok: false; reason: 'find_absent' } {
  switch (edit.mode) {
    case 'overwrite':
      return { ok: true, content: edit.content };
    case 'append': {
      // An empty memory has nothing to join to, so append becomes the text
      // itself — no leading separator.
      if (!current) return { ok: true, content: edit.content };
      const separator = edit.separator ?? DEFAULT_APPEND_SEPARATOR;
      return { ok: true, content: `${current}${separator}${edit.content}` };
    }
    case 'replace': {
      if (!current.includes(edit.find)) return { ok: false, reason: 'find_absent' };
      return {
        ok: true,
        content: edit.all
          ? current.split(edit.find).join(edit.replaceWith)
          : current.replace(edit.find, () => edit.replaceWith),
      };
    }
  }
}

function withBaseScores(results: MemorySearchResult[]): MemorySearchResult[] {
  return results.map((row) => ({
    ...row,
    base_score: row.combinedScore,
    adjusted_score: row.combinedScore,
  }));
}

export const memoryService = {
  async store(input: StoreMemoryInput): Promise<{ id: string; key: string; isDuplicate: boolean }> {
    const owner = toOwnerRef(input, 'memoryService.store');
    const status: MemoryStatus = input.status ?? 'active';
    const verified = input.verified ?? true;

    // Memory persistence is always available. Automatic semantic dedup and
    // indexing run only after positive local-intelligence opt-in.
    const { embedding, modelRowId } = isAutomaticLocalIntelligenceEnabled()
      ? await generateDocumentEmbedding(input.content)
      : { embedding: null, modelRowId: null };

    // Upsert by key first (same owner + same key should update existing memory).
    const existingByKey = await Memories.findByKey(owner, input.key);
    if (existingByKey) {
      // A proposal must never displace an approved/active memory: the human-
      // (or deliberately-)saved version wins and the unapproved candidate is
      // dropped. Proposed-onto-proposed refreshes the pending proposal, and an
      // explicit active store onto a proposed row promotes it — an owner
      // re-saving the key IS the approval.
      if (status === 'proposed' && existingByKey.status === 'active') {
        return { id: existingByKey.id, key: input.key, isDuplicate: true };
      }
      await Memories.update(existingByKey.id, {
        content: input.content,
        key: input.key,
        verified,
        status,
      });
      if (embedding && modelRowId) {
        await Embeddings.create({
          nodeId: existingByKey.id,
          modelId: modelRowId,
          vector: embedding,
        }).catch(logBestEffortFailure('update embedding'));
      }
      return { id: existingByKey.id, key: input.key, isDuplicate: true };
    }

    // Near-duplicate semantic dedup is an ACTIVE-store path only. A proposal
    // may not touch existing rows beyond its own key (above): silently
    // rewriting a semantically-similar active memory with unapproved content
    // would be exactly the overwrite the proposed status exists to prevent.
    if (embedding && status !== 'proposed') {
      const existing = await Memories.findNearDuplicate(owner, embedding, 0.95);
      if (existing) {
        await Memories.update(existing.id, {
          content: input.content,
          key: input.key,
          verified,
          status,
        });
        if (modelRowId) {
          await Embeddings.create({
            nodeId: existing.id,
            modelId: modelRowId,
            vector: embedding,
          }).catch(logBestEffortFailure('near-duplicate embedding'));
        }
        return { id: existing.id, key: input.key, isDuplicate: true };
      }
    }

    const id = generateId('memory');
    await Memories.create({
      id,
      agentId: owner.agentId ?? null,
      memberId: owner.memberId ?? null,
      key: input.key,
      content: input.content,
      sourceThreadId: input.threadId ?? null,
      verified,
      status,
    });

    if (embedding && modelRowId) {
      await Embeddings.create({
        nodeId: id,
        modelId: modelRowId,
        vector: embedding,
      }).catch(logBestEffortFailure('create embedding'));
    }

    // Track provenance via links. `context` is the canonical provenance
    // relation. Link to the SOURCE THREAD when present; skip the link entirely
    // when there is no thread — agents are not nodes, so a threadless memory
    // has nothing to link to, and ownership already lives in memories.agent_id
    // / memories.member_id.
    if (input.threadId) {
      Links.upsert({
        sourceId: id,
        targetId: input.threadId,
        relation: 'context',
        metadata: { created_by: ownerId(owner) },
      }).catch(logBestEffortFailure('create provenance link'));
    }

    // Link memory → the summary currently in effect for this (thread, agent).
    // One-to-one: the memory is attributed to the single summary that covered
    // the thread's context at extraction time. Agent-only: a thread summary is
    // an artifact of an agent's run, so this has no analog for a member/user-
    // owned memory — skip it entirely when the owner isn't an agent.
    if (input.threadId && owner.agentId) {
      const agentId = owner.agentId;
      ThreadSummaries.getByThreadAndAgent(input.threadId, agentId)
        .then((summary) => {
          if (!summary) return;
          return Links.upsert({
            sourceId: id,
            targetId: summary.id,
            relation: 'context',
            metadata: {
              thread_id: input.threadId,
              agent_id: agentId,
              summary_version: summary.version,
              linked_at: isoNow(),
              created_by: agentId,
            },
          });
        })
        .catch(logBestEffortFailure('create summary provenance link'));
    }

    return { id, key: input.key, isDuplicate: false };
  },

  async recall(input: RecallMemoryInput): Promise<MemorySearchResult[]> {
    const owner = toOwnerRef(input, 'memoryService.recall');
    const limit = clampInt(input.limit, 5, 1, MAX_RECALL_LIMIT);

    const { embedding } = await generateQueryEmbedding(input.query);
    const baseResults = await Memories.hybridSearch(embedding, input.query, owner, {
      limit,
      ...(input.projectScope ? { projectScope: input.projectScope } : {}),
      ...(input.alsoMemberId ? { alsoMemberId: input.alsoMemberId } : {}),
    });
    return withBaseScores(baseResults);
  },

  async forget(input: ForgetMemoryInput): Promise<{ count: number }> {
    const owner = toOwnerRef(input, 'memoryService.forget');
    if (input.memoryId) {
      const memory = await Memories.findById(input.memoryId);
      if (
        !memory ||
        memory.agentId !== (owner.agentId ?? null) ||
        memory.memberId !== (owner.memberId ?? null)
      ) {
        return { count: 0 };
      }
      const ok = await Memories.deleteOne(input.memoryId);
      return { count: ok ? 1 : 0 };
    }
    if (input.query) {
      const count = await Memories.deleteByQuery(owner, { query: input.query });
      return { count };
    }
    return { count: 0 };
  },

  /**
   * Edit ONE existing memory's content in place. Never creates (that's
   * `store`), never deletes (that's `forget`).
   *
   * Ownership works exactly like `forget`: `findByKey` is already owner-scoped
   * in SQL, while `findById` is not — so an id belonging to another owner is
   * checked here and reported as `not_found`, the same answer a nonexistent id
   * gets. A caller can never learn that another owner's memory exists, let
   * alone write to it.
   */
  async edit(input: EditMemoryInput): Promise<EditMemoryResult> {
    const owner = toOwnerRef(input, 'memoryService.edit');
    const target = toEditTarget(input, 'memoryService.edit');
    if (input.edit.mode === 'replace' && !input.edit.find) {
      throw new Error('memoryService.edit: replace requires a non-empty find string');
    }

    const existing =
      target.by === 'key'
        ? await Memories.findByKey(owner, target.key)
        : await Memories.findById(target.memoryId);
    if (
      !existing ||
      existing.agentId !== (owner.agentId ?? null) ||
      existing.memberId !== (owner.memberId ?? null)
    ) {
      return { status: 'not_found' };
    }

    const applied = applyMemoryEdit(existing.content, input.edit);
    if (!applied.ok) return { status: 'find_absent' };
    // Blanking a memory is `forget`'s job. Refuse rather than silently leaving
    // an empty row that still ranks in search.
    if (!applied.content.trim()) return { status: 'would_blank' };

    await Memories.update(existing.id, { content: applied.content });

    // Re-index so `recall` reflects the edit. Computed after the write (unlike
    // `store`, which needs the vector for its dedup lookup first) — a rejected
    // edit should never pay for an embedding.
    if (isAutomaticLocalIntelligenceEnabled()) {
      const { embedding, modelRowId } = await generateDocumentEmbedding(applied.content);
      if (embedding && modelRowId) {
        await Embeddings.create({
          nodeId: existing.id,
          modelId: modelRowId,
          vector: embedding,
        }).catch(logBestEffortFailure('edit embedding'));
      }
    }

    return { status: 'updated', id: existing.id, key: existing.key, content: applied.content };
  },

  async list(agentId: string, opts?: { limit?: number; offset?: number; threadId?: string }) {
    return Memories.listByAgent(agentId, opts);
  },

  /** Proposals recorded in a thread, waiting on a human's approval. */
  async listProposed(threadId: string): Promise<MemoryRow[]> {
    return Memories.listProposedByThread(threadId);
  },

  /**
   * Approve a proposal: it becomes an active memory, recallable from then on.
   * `not_proposed` covers a memory that is already active (approved twice, or
   * saved on purpose in the meantime), so approving never rewrites anything.
   */
  async approveProposed(
    id: string
  ): Promise<
    { status: 'approved'; memory: MemoryRow } | { status: 'not_found' } | { status: 'not_proposed' }
  > {
    const existing = await Memories.findById(id);
    if (!existing) return { status: 'not_found' };
    if (existing.status !== 'proposed') return { status: 'not_proposed' };
    const memory = await Memories.update(id, { status: 'active', verified: true });
    if (!memory) return { status: 'not_found' };
    // No re-embed: `store` already embedded the proposal (recall skips it by
    // status, not by a missing vector), so once active it is recallable as is.
    return { status: 'approved', memory };
  },

  async getById(id: string): Promise<MemoryRow | null> {
    return Memories.findById(id);
  },

  /** One memory with its agent's name and source thread's title (the memory preview). */
  async getDetailById(id: string): Promise<MemoryDetailRow | null> {
    return Memories.findDetailById(id);
  },

  async update(id: string, input: UpdateMemoryInput): Promise<MemoryRow | null> {
    return Memories.update(id, input);
  },

  async getStats(agentId: string) {
    return Memories.getStats(agentId);
  },
};
