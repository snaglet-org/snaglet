/**
 * ThreadModel — model for the `public.threads` table.
 *
 * `parent_thread_id` marks a hidden subagent helper thread. `kind` is 'chat'
 * or 'dm'; a DM carries `dm_pair_key` (set iff kind = 'dm', unique).
 */

import { Model } from '../../Model';
import { transaction } from '../../db';
import { quoteIdentifier } from '../../sql-utils';
import { Nodes, nodeInputError, threadPlacementError, type NodeRunner } from '../nodes';
import { PlacementEvents } from '../placementEvents';
import { Projects } from '../projects';
import { visibleThreadRowSql } from './visibility';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';
import { NODE_KIND } from '@snaglet/shared/constants';

/**
 * public.threads row shape, with parent public.nodes fields surfaced.
 *
 * Threads are not placed in the folder tree. A thread is scoped to a project
 * container (`projectId`) or is flat at the workspace level (`null`); its
 * node never has a `container_id` (`nodes_thread_no_container_chk`).
 */
export interface ThreadRow {
  id: string;
  title: string | null;
  lastMessageAt: string | null;
  /**
   * Project scope — a container with `category='project'` — or null for a
   * flat, workspace-level thread. From `nodes.project_id`.
   */
  projectId: string | null;
  /**
   * `nodes.sort_order`: the thread's manual position within its project
   * bucket (or the flat list), ascending. A new thread takes slot 0; activity
   * never changes it. Written only by {@link ThreadModel.moveTo}.
   */
  sortOrder: number;
  /**
   * Per-turn dispatch routing — `all` (every participant speaks) or
   * `mentioned` (only speak when @mentioned, otherwise silent).
   * CHECK-constrained at the database level: values outside the enum throw
   * at insert.
   */
  dispatchMode: 'all' | 'mentioned';
  /**
   * Conversation-wide cap on per-agent participation. Positive N = soft
   * threshold (hard ceiling is 2x); `0` = explicitly unlimited; `null` = use
   * the settings default (not unlimited).
   */
  maxAgentDispatches: number | null;
  /**
   * Cap on dispatch waves per user message.
   *   `null` = settings default · `-1` = unbounded · N > 0 = exactly N.
   *
   * The `-1` sentinel exists because this setting has three states and a
   * nullable integer only has two: collapsing an absent override and an
   * explicit "unbounded" would silently make every unset thread unbounded.
   */
  maxWaves: number | null;
  /** Conversation-total output-token cap. Null = settings default. Ceiling-clamped on read. */
  maxTotalOutputTokens: number | null;
  /** Thread-wide tool access. Null mode = unrestricted. */
  toolAccessMode: 'all' | 'allow_list' | 'deny_list' | null;
  toolAccessAllowList: string[] | null;
  toolAccessDenyList: string[] | null;
  /**
   * Optional prompt fragment appended to every participating agent's system
   * prompt while running in this thread. Composer order:
   *   agent.system_prompt → threads.thread_system_prompt →
   *   thread_participants.system_prompt_addendum
   * Null = no thread-level addendum.
   */
  threadSystemPrompt: string | null;
  /** Person-managed execution default; validated again at use time. */
  workingDirectory?: string | null;
  /** From parent public.nodes row. */
  createdAt: string;
  /** From parent public.nodes row. May be null if node has never been updated. */
  updatedAt: string | null;
  /** From parent public.nodes row. True if the thread has been archived. */
  archived: boolean;
  /** From parent public.nodes row. ISO timestamp when archived, or null. */
  archivedAt: string | null;
  /**
   * Set on a subagent helper thread: the thread whose agent started
   * the helper. Helper threads are hidden from every listing and never take
   * a slot in a project's list.
   */
  parentThreadId: string | null;
  /** 'dm' marks a direct-message thread between two members; every other thread is 'chat'. */
  kind: 'chat' | 'dm';
  /** Sorted `memberA:memberB` (members.id) of a DM's two members; set iff kind = 'dm'. */
  dmPairKey: string | null;
}

const DISPATCH_MODES: ReadonlyArray<string> = ['all', 'mentioned'];

/** Most recently active first; threads that never spoke sort by creation. */
const THREAD_ACTIVITY_ORDER = 't.last_message_at DESC NULLS LAST, t.created_at DESC';

/**
 * Every thread listing leaves out subagent helper threads: they are
 * reached only through their parent thread. Per-id lookups still resolve them.
 */
const VISIBLE_THREAD = visibleThreadRowSql('t');

/** The sidebar order: manual position, with activity only breaking ties. */
const THREAD_MANUAL_ORDER = `n.sort_order ASC, ${THREAD_ACTIVITY_ORDER}`;

export interface CreateThreadInput {
  id: string;
  title?: string | null;
  /** Project scope; omitted or null creates a flat thread. */
  projectId?: string | null;
  maxAgentDispatches?: number | null;
  dispatchMode?: 'all' | 'mentioned';
  /** Shared prompt addendum for everyone in this thread. Null = none. */
  threadSystemPrompt?: string | null;
  /**
   * Makes this a hidden subagent helper thread of that parent thread.
   * It keeps `projectId` for its project folder but takes no list slot.
   */
  parentThreadId?: string | null;
  /** 'dm' creates a direct-message thread; it requires `dmPairKey`, and a chat thread forbids it. */
  kind?: 'chat' | 'dm';
  dmPairKey?: string | null;
  /** Threads have no folder placement — refused at compile time and at runtime. */
  containerId?: never;
  /** A new thread always starts at the top of its list (slot 0). */
  sortOrder?: never;
  /**
   * Insert the thread row but do not shift the sibling list yet. The sibling
   * shift (`openSlot`) locks every live row in the target list, so a caller
   * running inside a long transaction (the fork copy) would hold those locks
   * the whole time and stall an unrelated "New thread". With this set, the
   * row is inserted with no slot opened; the caller owns the transaction and
   * must call `openSlot(projectId, 0, tx, id)` itself at the end, keeping the
   * sibling lock short. Only valid with a caller-supplied `runner`; ignored
   * for a helper/DM thread, which takes no slot anyway.
   */
  deferListSlot?: boolean;
}

/**
 * Where {@link ThreadModel.moveTo} puts a thread. `projectId` omitted keeps
 * the current project; `sortOrder` omitted means the top (slot 0) on a
 * project change and "leave it where it is" otherwise.
 */
export interface ThreadPlacementInput {
  projectId?: string | null;
  sortOrder?: number;
}

export interface UpdateThreadInput {
  title?: string | null;
  /** Move the thread to a project, or to the workspace level with null. */
  projectId?: string | null;
  /** Manual position in the (target) project's list; see {@link ThreadPlacementInput}. */
  sortOrder?: number;
  maxAgentDispatches?: number | null;
  /** See ThreadRow.maxWaves — `-1` means unbounded, null means settings default. */
  maxWaves?: number | null;
  maxTotalOutputTokens?: number | null;
  toolAccessMode?: 'all' | 'allow_list' | 'deny_list' | null;
  toolAccessAllowList?: string[] | null;
  toolAccessDenyList?: string[] | null;
  dispatchMode?: 'all' | 'mentioned';
  /** Shared prompt addendum for everyone in this thread. Pass null to clear. */
  threadSystemPrompt?: string | null;
  /** Threads have no folder placement — refused at compile time and at runtime. */
  containerId?: never;
}

/** Throw when a caller still hands a thread write a folder placement. */
function assertNoFolderPlacement(input: object, id?: string): void {
  if ((input as { containerId?: unknown }).containerId !== undefined) {
    throw threadPlacementError(id);
  }
}

/** Reject a thread slot the integer `nodes.sort_order` column would refuse, or a negative one. */
function assertThreadSlot(value: unknown): asserts value is number | undefined {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw nodeInputError(`sortOrder must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
}

/**
 * Effective model resolution: cascades thread_participants → agents.
 * `credentialId` is an opaque handle resolved at use time by the provider
 * router.
 */
interface EffectiveModel {
  /** Non-null by construction: a cascade that cannot resolve a provider
   *  returns `null` from `getEffectiveModel` (resolution is all-or-nothing). */
  providerId: string;
  /** Non-null by construction (see providerId). */
  modelId: string;
  credentialId: string | null;
  /** Which cascade level produced the winning row. */
  source: 'thread_participant' | 'agent';
}

class ThreadModel extends Model<ThreadRow, CreateThreadInput, UpdateThreadInput> {
  constructor() {
    super({
      table: 'threads',
      updatedAtColumn: null, // public.threads has no updated_at; lives on public.nodes
      columnMap: {
        lastMessageAt: 'last_message_at',
        projectId: 'project_id',
        sortOrder: 'sort_order',
        dispatchMode: 'dispatch_mode',
        threadSystemPrompt: 'thread_system_prompt',
        parentThreadId: 'parent_thread_id',
        dmPairKey: 'dm_pair_key',
      },
    });
  }

  /**
   * SELECT expression joining public.nodes for the project scope, archive
   * state and timestamps. Participants live in the thread_participants table.
   */
  private get threadSelect(): string {
    return `
      SELECT
        t.id            AS "id",
        t.title         AS "title",
        t.last_message_at AS "lastMessageAt",
        n.project_id    AS "projectId",
        n.sort_order    AS "sortOrder",
        t.dispatch_mode AS "dispatchMode",
        t.max_agent_dispatches AS "maxAgentDispatches",
        t.max_waves     AS "maxWaves",
        t.max_total_output_tokens AS "maxTotalOutputTokens",
        t.tool_access_mode AS "toolAccessMode",
        t.tool_access_allow_list AS "toolAccessAllowList",
        t.tool_access_deny_list AS "toolAccessDenyList",
        t.thread_system_prompt AS "threadSystemPrompt",
        t.working_directory AS "workingDirectory",
        t.created_at    AS "createdAt",
        n.updated_at    AS "updatedAt",
        n.archived      AS "archived",
        n.archived_at   AS "archivedAt",
        t.parent_thread_id AS "parentThreadId",
        t.kind          AS "kind",
        t.dm_pair_key   AS "dmPairKey"
      FROM ${this.qualifiedTable} t
      JOIN ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')} n ON n.id = t.id
    `.trim();
  }

  /**
   * Insert a new thread row, flat or scoped to `projectId`, at the top of
   * that list: it takes slot 0 and every live thread already there shifts
   * down by one (a helper or DM thread, which no list shows, takes no slot).
   * The scope target is checked first (`Projects.assertProjectContainer`); a
   * folder placement or an explicit sort order is refused.
   */
  async create(input: CreateThreadInput, runner?: NodeRunner): Promise<ThreadRow> {
    const {
      id,
      title = null,
      projectId = null,
      maxAgentDispatches = null,
      dispatchMode = 'mentioned',
      threadSystemPrompt = null,
      parentThreadId = null,
      kind = 'chat',
      dmPairKey = null,
      deferListSlot = false,
    } = input;

    assertNoFolderPlacement(input, id);
    if (deferListSlot && !runner) {
      throw nodeInputError(
        `Thread ${id}: deferListSlot requires a caller-supplied runner so the caller can open the slot in the same transaction`
      );
    }
    if ((input as { sortOrder?: unknown }).sortOrder !== undefined) {
      throw nodeInputError(
        `Thread ${id} takes no sort order on create: a new thread always starts at the top of its list`
      );
    }
    if (kind !== 'chat' && kind !== 'dm') {
      throw nodeInputError(`kind must be one of chat|dm`);
    }
    if (kind === 'dm' && !dmPairKey) {
      throw nodeInputError(`Thread ${id} is a dm and needs a dmPairKey`);
    }
    if (kind === 'chat' && dmPairKey) {
      throw nodeInputError(`Thread ${id} is a chat and takes no dmPairKey`);
    }
    if (!DISPATCH_MODES.includes(dispatchMode)) {
      throw nodeInputError(`dispatchMode must be one of ${DISPATCH_MODES.join('|')}`);
    }

    // The spine row, its project scope, and the threads row commit together,
    // so a failed insert never leaves an orphan `nodes` row behind.
    const insertThread = async (tx: NodeRunner): Promise<void> => {
      await Projects.assertProjectContainer(projectId, tx);
      // public.threads inherits from public.nodes; the node row must exist first.
      await Nodes.ensure(id, NODE_KIND.THREAD, { runner: tx });
      if (projectId !== null) {
        await tx.query(
          `UPDATE ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}
             SET project_id = $1
           WHERE id = $2`,
          [projectId, id]
        );
      }
      // Helper and DM threads are not in any list, so they must not shift the
      // visible threads' positions (nor lock every flat thread's row: DM
      // creates race on purpose, see DmService.findOrCreate). `deferListSlot`
      // lets a long-transaction caller (the fork) open the slot itself at the
      // end so the sibling-row lock is not held across the whole copy.
      if (parentThreadId === null && kind === 'chat' && !deferListSlot) {
        await this.openSlot(projectId, 0, tx, id);
      }
      await tx.query(
        `INSERT INTO ${this.qualifiedTable}
           (id, title, dispatch_mode, max_agent_dispatches, thread_system_prompt, parent_thread_id,
            kind, dm_pair_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          title,
          dispatchMode,
          maxAgentDispatches ?? null,
          threadSystemPrompt,
          parentThreadId,
          kind,
          dmPairKey,
        ]
      );
    };
    // A caller that passes its own runner owns the transaction: the thread
    // commits (or rolls back) together with whatever else the caller wrote,
    // and the row is read back inside that same transaction.
    if (runner) await insertThread(runner);
    else await transaction(insertThread);

    const row = await this.findById(id, runner);
    if (!row) {
      throw new Error(`ThreadModel.create: insert succeeded but row not found (id=${id})`);
    }
    return row;
  }

  /** Fetch a single thread by id, with parent-node timestamps. */
  async findById(id: string, runner?: NodeRunner): Promise<ThreadRow | null> {
    const { rows } = await (runner ?? this.pool).query(`${this.threadSelect} WHERE t.id = $1`, [
      id,
    ]);
    return (rows[0] as ThreadRow) ?? null;
  }

  /** The DM thread of a member pair, by its sorted `dm_pair_key`; null when none yet. */
  async findByDmPairKey(dmPairKey: string, runner?: NodeRunner): Promise<ThreadRow | null> {
    const { rows } = await (runner ?? this.pool).query(
      `${this.threadSelect} WHERE t.dm_pair_key = $1`,
      [dmPairKey]
    );
    return (rows[0] as ThreadRow) ?? null;
  }

  /** Ids of every DM thread an agent is a participant of, so they can go with the agent. */
  async listDmIdsForAgent(agentId: string, runner?: NodeRunner): Promise<string[]> {
    const { rows } = await (runner ?? this.pool).query<{ id: string }>(
      `SELECT t.id FROM ${this.qualifiedTable} t
         JOIN public.thread_participants tp ON tp.thread_id = t.id
         JOIN public.members m ON m.id = tp.member_id
        WHERE t.kind = 'dm' AND m.agent_id = $1
        ORDER BY t.id`,
      [agentId]
    );
    return rows.map((r) => r.id);
  }

  /**
   * The home threads among `ids`, sorted: a home thread is the user's DM with
   * an agent, a `kind = 'dm'` thread with a user member. An agent-to-agent DM
   * has none. The same rule the fork (`forkHomeThread`) and the UI apply.
   */
  async listHomeThreadIds(ids: readonly string[], runner?: NodeRunner): Promise<string[]> {
    if (ids.length === 0) return [];
    const { rows } = await (runner ?? this.pool).query<{ id: string }>(
      `SELECT DISTINCT t.id FROM ${this.qualifiedTable} t
         JOIN public.thread_participants tp ON tp.thread_id = t.id
         JOIN public.members m ON m.id = tp.member_id
        WHERE t.id = ANY($1::text[]) AND t.kind = 'dm' AND m.kind = 'user'
        ORDER BY t.id`,
      [[...ids]]
    );
    return rows.map((r) => r.id);
  }

  /**
   * List all threads ordered by recency of last message (NULLS LAST so
   * empty threads sort to the bottom). Override of base Model.list — the
   * base implementation defaults ORDER BY to `created_at`, which doesn't
   * exist on public.threads (it lives on the public.nodes parent row).
   */
  override async list(opts?: { limit?: number; offset?: number }): Promise<ThreadRow[]> {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const { rows } = await this.pool.query(
      `${this.threadSelect}
       WHERE ${VISIBLE_THREAD}
       ORDER BY t.last_message_at DESC NULLS LAST, t.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows as ThreadRow[];
  }

  /**
   * All active threads in one query: flat threads first (project_id NULL),
   * then each project's, each list in its manual order (`sort_order`, with
   * last activity only breaking ties). Archived threads are queried via
   * /api/archive/*.
   */
  async listAllOrdered(): Promise<ThreadRow[]> {
    const { rows } = await this.pool.query(
      `${this.threadSelect}
       WHERE n.archived = false AND ${VISIBLE_THREAD}
       ORDER BY n.project_id NULLS FIRST, ${THREAD_MANUAL_ORDER}`
    );
    return rows as ThreadRow[];
  }

  /**
   * Threads scoped to `projectId`, or the flat (workspace-level) threads when
   * `projectId` is null, in their manual order (`sort_order`, with last
   * activity only breaking ties). Archived threads are left out unless
   * `includeArchived` is set (the archive and clone paths want the full set).
   */
  async listByProject(
    projectId: string | null,
    opts: { includeArchived?: boolean } = {}
  ): Promise<ThreadRow[]> {
    const where = projectId === null ? 'n.project_id IS NULL' : 'n.project_id = $1';
    const values = projectId === null ? [] : [projectId];
    const archived = opts.includeArchived ? '' : ' AND n.archived = false';
    const { rows } = await this.pool.query(
      `${this.threadSelect} WHERE ${where}${archived} AND ${VISIBLE_THREAD} ORDER BY ${THREAD_MANUAL_ORDER}`,
      values
    );
    return rows as ThreadRow[];
  }

  /** Active threads in one project, in manual order. */
  async findByProject(projectId: string): Promise<ThreadRow[]> {
    return this.listByProject(projectId);
  }

  /** Active flat (workspace-level) threads, in manual order. */
  async findFlat(): Promise<ThreadRow[]> {
    return this.listByProject(null);
  }

  /**
   * List threads where the given agent is a participant (any role).
   * Ordered by recency of last message; empty threads sort to the bottom
   * (NULLS LAST) — matches chat-UI convention.
   */
  async listByAgent(agentId: string, limit = 50): Promise<ThreadRow[]> {
    const tp = `${quoteIdentifier(this.schema)}.${quoteIdentifier('thread_participants')}`;
    const mem = `${quoteIdentifier(this.schema)}.${quoteIdentifier('members')}`;
    const { rows } = await this.pool.query(
      `${this.threadSelect}
       WHERE EXISTS (
         SELECT 1 FROM ${tp} tp
         JOIN ${mem} m ON m.id = tp.member_id
         WHERE tp.thread_id = t.id AND m.agent_id = $1
       ) AND ${VISIBLE_THREAD}
       ORDER BY t.last_message_at DESC NULLS LAST
       LIMIT $2`,
      [agentId, limit]
    );
    return rows as ThreadRow[];
  }

  /** Update only the title. Returns the updated row or null if not found. */
  async updateTitle(id: string, title: string): Promise<ThreadRow | null> {
    const res = await this.pool.query(
      `UPDATE ${this.qualifiedTable} SET title = $2 WHERE id = $1`,
      [id, title]
    );
    if (res.rowCount === 0) return null;
    return this.findById(id);
  }

  /**
   * Reset last_message_at to NULL after a thread's messages are cleared. The
   * maintaining trigger (trg_messages_update_thread_last) is INSERT-only, so it
   * never lowers the value on delete — the clear path resets it explicitly.
   */
  async resetLastMessageAt(id: string, runner?: NodeRunner): Promise<void> {
    const r = runner ?? this.pool;
    await r.query(`UPDATE ${this.qualifiedTable} SET last_message_at = NULL WHERE id = $1`, [id]);
  }

  /**
   * Callers must validate the folder first (`validateThreadWorkingDirectory`):
   * the person's settings route and the thread tool's update op both do.
   */
  async setWorkingDirectory(id: string, directory: string | null): Promise<ThreadRow | null> {
    const { rowCount } = await this.pool.query(
      'UPDATE public.threads SET working_directory = $2 WHERE id = $1',
      [id, directory]
    );
    return rowCount ? this.findById(id) : null;
  }

  /**
   * Update thread settings. Every field is written only when the caller names
   * it, so an unmentioned setting keeps its stored value. A `projectId` and/or
   * `sortOrder` goes through {@link moveTo} (validation, sibling shift and
   * placement history) before the settings columns are written.
   */
  async updateSettings(id: string, input: UpdateThreadInput): Promise<ThreadRow | null> {
    assertNoFolderPlacement(input, id);
    assertThreadSlot(input.sortOrder);
    let touched = 0;
    if (input.projectId !== undefined || input.sortOrder !== undefined) {
      const placed = await this.moveTo(id, {
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      });
      if (!placed) return null;
      touched += 1;
    }

    const threadSets: string[] = [];
    const threadParams: unknown[] = [id];
    if (input.title !== undefined) {
      threadParams.push(input.title);
      threadSets.push(`title = $${threadParams.length}`);
    }
    if (input.dispatchMode !== undefined) {
      threadParams.push(input.dispatchMode);
      threadSets.push(`dispatch_mode = $${threadParams.length}`);
    }
    if (input.threadSystemPrompt !== undefined) {
      threadParams.push(input.threadSystemPrompt);
      threadSets.push(`thread_system_prompt = $${threadParams.length}`);
    }
    // Typed budget / tool-access columns. Each is written only when the
    // caller names it, so an unmentioned field keeps its stored value rather
    // than being reset.
    const scalarColumns: Array<[keyof UpdateThreadInput, string]> = [
      ['maxAgentDispatches', 'max_agent_dispatches'],
      ['maxWaves', 'max_waves'],
      ['maxTotalOutputTokens', 'max_total_output_tokens'],
      ['toolAccessMode', 'tool_access_mode'],
    ];
    for (const [field, column] of scalarColumns) {
      if (input[field] !== undefined) {
        threadParams.push(input[field]);
        threadSets.push(`${column} = $${threadParams.length}`);
      }
    }
    const jsonColumns: Array<[keyof UpdateThreadInput, string]> = [
      ['toolAccessAllowList', 'tool_access_allow_list'],
      ['toolAccessDenyList', 'tool_access_deny_list'],
    ];
    for (const [field, column] of jsonColumns) {
      const value = input[field];
      if (value !== undefined) {
        threadParams.push(value === null ? null : JSON.stringify(value));
        threadSets.push(`${column} = $${threadParams.length}::jsonb`);
      }
    }

    if (threadSets.length > 0) {
      const res = await this.pool.query(
        `UPDATE ${this.qualifiedTable} SET ${threadSets.join(', ')} WHERE id = $1`,
        threadParams
      );
      touched += res.rowCount ?? 0;
    } else if (touched === 0) {
      return this.findById(id);
    }
    if (touched === 0) return null;
    return this.findById(id);
  }

  /**
   * Shift every live thread in the `projectId` bucket (null = the flat list)
   * at `slot` or later down by one, making room for a thread placed at
   * `slot`. `exceptId` (the thread being placed) is left alone. Archived
   * threads are skipped: `archived_node_immutable_guard` refuses any
   * sort_order write on them, and no list shows them. Run it inside the
   * transaction that places the thread.
   */
  async openSlot(
    projectId: string | null,
    slot: number,
    runner: NodeRunner,
    exceptId?: string
  ): Promise<void> {
    assertThreadSlot(slot);
    await runner.query(
      `UPDATE ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}
          SET sort_order = sort_order + 1
        WHERE type = 'thread'
          AND project_id IS NOT DISTINCT FROM $1
          AND id IS DISTINCT FROM $2
          AND sort_order >= $3
          AND archived = false`,
      [projectId, exceptId ?? null, slot]
    );
  }

  /**
   * Move a thread into project `projectId`, or out to the workspace level
   * with null — the top of that list. Shorthand for {@link moveTo} with no
   * slot; a move to the project the thread is already in changes nothing.
   */
  async setProject(id: string, projectId: string | null): Promise<ThreadRow | null> {
    return this.moveTo(id, { projectId });
  }

  /**
   * Atomic "drop to position" for a thread: place it at `sortOrder` in the
   * target project's list (`projectId`, null = flat; omitted = its current
   * project), shifting every live sibling at that slot or later down by one
   * — the same contract as `ContainerModel.moveTo`, scoped by `project_id`.
   * A project change without a slot lands at the top (slot 0); neither field
   * changing anything is a no-op.
   *
   * The target is checked (`Projects.assertProjectContainer`) and a project
   * change is recorded in `placement_events` using its from/to columns — a
   * project is a container, and those columns hold container ids with no FK,
   * so the thread's history survives alongside the folder moves of every
   * other kind. A pure reorder records nothing.
   *
   * Returns the updated row, or null when `id` is not a thread. An archived
   * thread is immutable (the database refuses the write as well).
   */
  async moveTo(id: string, placement: ThreadPlacementInput): Promise<ThreadRow | null> {
    assertThreadSlot(placement.sortOrder);
    const nodesTable = `${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}`;
    const moved = await transaction(async (tx) => {
      if (placement.projectId !== undefined) {
        await Projects.assertProjectContainer(placement.projectId, tx);
      }
      const { rows } = await tx.query<{ project_id: string | null; archived: boolean }>(
        `SELECT project_id, archived FROM ${nodesTable} WHERE id = $1 AND type = 'thread' FOR UPDATE`,
        [id]
      );
      const current = rows[0];
      if (!current) return false;
      if (current.archived) {
        throw new AppError(
          `Thread ${id} is archived; restore it before moving it`,
          ErrorCode.VALIDATION_ERROR,
          400
        );
      }
      const target = placement.projectId !== undefined ? placement.projectId : current.project_id;
      const projectChanged = target !== current.project_id;
      // A home thread stays flat: deleting or archiving a project takes its
      // threads with it, and a home thread must never go that way.
      if (projectChanged && target !== null && (await this.listHomeThreadIds([id], tx)).length) {
        throw new AppError(
          "The home thread can't be moved into a project.",
          ErrorCode.VALIDATION_ERROR,
          400
        );
      }
      if (!projectChanged && placement.sortOrder === undefined) return true;
      const slot = placement.sortOrder ?? 0;
      // One statement, so readers see the old order or the new one, never a
      // half-shifted list. The shift excludes the moved thread, which the
      // outer UPDATE places itself.
      await tx.query(
        `WITH siblings_shift AS (
           UPDATE ${nodesTable}
              SET sort_order = sort_order + 1
            WHERE type = 'thread'
              AND project_id IS NOT DISTINCT FROM $2
              AND id <> $1
              AND sort_order >= $3
              AND archived = false
         )
         UPDATE ${nodesTable}
            SET project_id = $2, sort_order = $3
          WHERE id = $1`,
        [id, target, slot]
      );
      if (projectChanged) {
        await PlacementEvents.record({
          nodeId: id,
          fromContainerId: current.project_id,
          toContainerId: target,
          runner: tx,
        });
      }
      return true;
    });
    return moved ? this.findById(id) : null;
  }

  /**
   * Resolve the effective (providerId, modelId, credentialId) for a given
   * thread + agent pair. Cascade:
   *   1. thread_participants row for (thread, agent) — per-thread override
   *   2. agents row — the agent's own default
   *
   * Returns null if neither level yields a modelId (the minimum useful
   * resolution). `credentialId` is an opaque handle; this DAL does not
   * resolve secrets.
   */
  async getEffectiveModel(threadId: string, agentId: string): Promise<EffectiveModel | null> {
    const tp = `${quoteIdentifier(this.schema)}.${quoteIdentifier('thread_participants')}`;
    const ag = `${quoteIdentifier(this.schema)}.${quoteIdentifier('agents')}`;
    const mem = `${quoteIdentifier(this.schema)}.${quoteIdentifier('members')}`;
    const credentials = `${quoteIdentifier(this.schema)}.${quoteIdentifier('user_provider_credentials')}`;

    // The participant references its principal via member_id; the agent
    // identity lives on members, so reach the participant override by
    // agent -> member -> thread_participants.
    const { rows } = await this.pool.query(
      `SELECT
         tp.provider_id                        AS "tpProviderId",
         tp.model_id                           AS "tpModelId",
         tp.credential_id                      AS "tpCredentialId",
         COALESCE(a.provider_id, ac.provider_id) AS "agentProviderId",
         a.model_id                            AS "agentModelId",
         a.credential_id                       AS "agentCredentialId"
       FROM ${ag} a
       LEFT JOIN ${credentials} ac ON ac.id = a.credential_id
       LEFT JOIN ${mem} m ON m.agent_id = a.id
       LEFT JOIN ${tp} tp
         ON tp.thread_id = $1 AND tp.member_id = m.id
       WHERE a.id = $2`,
      [threadId, agentId]
    );

    const row = rows[0] as
      | {
          tpProviderId: string | null;
          tpModelId: string | null;
          tpCredentialId: string | null;
          agentProviderId: string | null;
          agentModelId: string | null;
          agentCredentialId: string | null;
        }
      | undefined;

    if (!row) return null;

    // Thread-participant override wins if it has both providerId and modelId
    // (all-or-nothing; partial cascades return null).
    if (row.tpProviderId && row.tpModelId) {
      return {
        providerId: row.tpProviderId,
        modelId: row.tpModelId,
        credentialId: row.tpCredentialId,
        source: 'thread_participant',
      };
    }

    // A partial override is invalid, not permission to mix providers, models
    // or credentials from different levels. Empty overrides inherit the agent.
    if (row.tpProviderId || row.tpModelId || row.tpCredentialId) return null;

    // Credential-backed agents may omit provider_id; the referenced
    // credential supplies the provider, never a guess from the model name.
    if (row.agentProviderId && row.agentModelId) {
      return {
        providerId: row.agentProviderId,
        modelId: row.agentModelId,
        credentialId: row.agentCredentialId,
        source: 'agent',
      };
    }

    return null;
  }
}

export const Threads = new ThreadModel();
