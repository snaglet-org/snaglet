/**
 * DocModel — public.docs.
 *
 * Markdown document node in the library. Shared-PK with public.nodes
 * (type='doc'); deleting the nodes row cascades to the doc row via
 * docs_id_fkey. Placement (container_id, sort_order) lives on nodes.
 *
 * `search_text` is a tsvector kept current by the
 * public.docs_update_search_text trigger on insert/update of title/content.
 * The trigger owns it; do not write search_text directly.
 *
 * This model stays internal until the document domain owns the public API.
 */

import { generateId } from '@snaglet/shared/utils';
import { NODE_KIND } from '@snaglet/shared/constants';
import { Model } from '@snaglet/db/Model';
import { transaction } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import {
  Nodes,
  assertSortOrderInput,
  assertTimestampInput,
  nodeInputError,
  type NodeRunner,
} from '@snaglet/db/tables/nodes';
import { PlacementEvents } from '@snaglet/db/tables/placementEvents';
import { currentActorMemberId } from '@snaglet/db/actorMember';
import { assertNoTransclusionLoop } from './transclusionLoop';

export interface DocRow {
  id: string;
  containerId: string | null;
  title: string;
  content: string;
  /** Optional task-ish fields, nullable. */
  dueAt: string | null;
  assignedTo: string | null;
  priority: string | null;
  /**
   * Creation stamp — the members.id of the actor who created the doc. Set
   * once at create from the resolved ambient actor;
   * FK → members(id) ON DELETE SET NULL. Not caller-settable.
   */
  createdBy: string | null;
  /**
   * Edit stamp — the members.id of the actor who last modified title/content.
   * Re-stamped at every content/title edit (never on a pure move/reorder or a
   * metadata-only change); FK → members(id) ON DELETE SET NULL. Not caller-settable.
   */
  lastEditedBy: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  archivedAt: string | null;
}

export interface CreateDocInput {
  id?: string;
  containerId?: string | null;
  title: string;
  content?: string;
  dueAt?: string | null;
  assignedTo?: string | null;
  priority?: string | null;
  sortOrder?: number;
  // createdBy / lastEditedBy are not accepted here: both are derived from the
  // ambient actor at the model chokepoints (create stamps createdBy; a
  // content/title edit stamps lastEditedBy).
}

export interface UpdateDocInput {
  containerId?: string | null;
  title?: string;
  content?: string;
  dueAt?: string | null;
  assignedTo?: string | null;
  priority?: string | null;
  sortOrder?: number;
}

export interface DocSearchHit extends DocRow {
  rank: number;
}

interface DocRawRow {
  id: string;
  container_id: string | null;
  title: string;
  content: string;
  due_at: string | null;
  assigned_to: string | null;
  priority: string | null;
  created_by: string | null;
  last_edited_by: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  archived: boolean;
  archived_at: string | null;
}

function mapDocRow(raw: DocRawRow): DocRow {
  return {
    id: raw.id,
    containerId: raw.container_id,
    title: raw.title,
    content: raw.content,
    dueAt: raw.due_at ?? null,
    assignedTo: raw.assigned_to ?? null,
    priority: raw.priority ?? null,
    createdBy: raw.created_by ?? null,
    lastEditedBy: raw.last_edited_by ?? null,
    sortOrder: raw.sort_order,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    archived: raw.archived ?? false,
    archivedAt: raw.archived_at ?? null,
  };
}

/**
 * Reject doc field values the docs table would refuse (the `due_at
 * timestamptz` cast) before any write, so they surface as a 400.
 */
function assertDocFields(input: Pick<UpdateDocInput, 'dueAt'>): void {
  assertTimestampInput('dueAt', input.dueAt);
}

class DocModelClass extends Model<DocRow, CreateDocInput, UpdateDocInput> {
  constructor() {
    super({
      table: 'docs',
      primaryKey: 'id',
      updatedAtColumn: null, // updatedAt lives on public.nodes
      columnMap: {
        containerId: 'container_id',
        sortOrder: 'sort_order',
      },
    });
  }

  private get docSelect(): string {
    // Placement (container_id, sort_order) is read from nodes.
    return `
      SELECT d.id, n.container_id AS container_id, d.title, d.content,
             d.due_at, d.assigned_to, d.priority,
             d.created_by, d.last_edited_by,
             n.sort_order AS sort_order,
             d.created_at, n.updated_at, n.archived, n.archived_at
      FROM ${this.qualifiedTable} d
      JOIN ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')} n ON n.id = d.id
    `.trim();
  }

  override async create(input: CreateDocInput): Promise<DocRow> {
    if (typeof input.title !== 'string') throw nodeInputError('title must be a string');
    assertDocFields(input);
    assertSortOrderInput(input.sortOrder);
    const id = input.id ?? generateId('doc');
    const containerId = input.containerId ?? null;
    await assertNoTransclusionLoop(this.pool, {
      id,
      content: input.content ?? '',
      previous: null,
      title: input.title,
    });
    // created_by: derived creation stamp — the members.id of the ambient
    // actor (null when unattributed). Never taken from caller input.
    const createdBy = await currentActorMemberId();
    const nodesTable = `${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}`;
    // The spine row, its placement, and the docs row commit together, so a
    // failed insert never leaves an orphan `nodes` row behind.
    await transaction(async (tx) => {
      await Nodes.assertPlacementParent(containerId, tx);
      await Nodes.ensure(id, NODE_KIND.DOC, { runner: tx });
      const sortOrder = await this.resolveSortOrder(input.sortOrder, containerId, tx);
      // Same bump-then-set CTE as moveTo: an explicit sortOrder (the tree's
      // drop-between-rows import) shifts siblings at/past the slot by +1
      // instead of colliding. The append path (resolved MAX+1) matches no
      // siblings, so the bump is a no-op there.
      await tx.query(
        `WITH siblings_bump AS (
           UPDATE ${nodesTable}
              SET sort_order = sort_order + 1
            WHERE type = 'doc'
              AND container_id IS NOT DISTINCT FROM $1
              AND id <> $3
              AND sort_order >= $2
              AND archived = false
         )
         UPDATE ${nodesTable}
            SET container_id = $1, sort_order = $2
          WHERE id = $3`,
        [containerId, sortOrder, id]
      );
      await tx.query(
        `INSERT INTO ${this.qualifiedTable}
           (id, title, content, due_at, assigned_to, priority, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          input.title,
          input.content ?? '',
          input.dueAt ?? null,
          input.assignedTo ?? null,
          input.priority ?? null,
          createdBy,
        ]
      );
    });
    const row = await this.findById(id);
    if (!row) throw new Error(`DocModel.create: row ${id} missing after insert`);
    return row;
  }

  /**
   * Resolve the effective sort_order for an insert. Explicit caller value
   * passes through; otherwise the new doc lands at the end of its
   * container bucket via `COALESCE(MAX(sort_order), 0) + 1`. Mirrors
   * ThreadModel.resolveSortOrder / ContainerModel.resolveSortOrder — see
   * those for the concurrency tradeoff (ties under simultaneous inserts
   * fall back to the secondary `title` sort).
   */
  private async resolveSortOrder(
    explicit: number | undefined,
    containerId: string | null,
    runner: NodeRunner = this.pool
  ): Promise<number> {
    if (explicit !== undefined) return explicit;
    // Read MAX(sort_order) from nodes, scoped to type='doc'.
    const { rows } = await runner.query<{ next: number }>(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next
         FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}
        WHERE type = 'doc' AND container_id IS NOT DISTINCT FROM $1`,
      [containerId]
    );
    return rows[0]?.next ?? 1;
  }

  override async findById(id: string): Promise<DocRow | null> {
    const raw = await this.rawQueryOne<DocRawRow>(`${this.docSelect} WHERE d.id = $1`, [id]);
    return raw ? mapDocRow(raw) : null;
  }

  /** List docs in a container (or null for loose docs). */
  async listByContainer(containerId: string | null): Promise<DocRow[]> {
    const where = containerId === null ? 'n.container_id IS NULL' : 'n.container_id = $1';
    const values = containerId === null ? [] : [containerId];
    const raws = await this.rawQuery<DocRawRow>(
      `${this.docSelect} WHERE ${where} ORDER BY n.sort_order, d.title`,
      values
    );
    return raws.map(mapDocRow);
  }

  /** Loose docs (not in any container). */
  async listLoose(): Promise<DocRow[]> {
    return this.listByContainer(null);
  }

  /**
   * All active docs in one query, returned in (container_id, sort_order, title)
   * order. Excludes archived rows (`nodes.archived = true`) — archived rows
   * are queried via the dedicated `/api/archive/*` endpoints, not this
   * tree-rendering path.
   */
  async listAllOrdered(): Promise<DocRow[]> {
    const raws = await this.rawQuery<DocRawRow>(
      `${this.docSelect}
        WHERE n.archived = false
        ORDER BY n.container_id NULLS FIRST, n.sort_order, d.title`,
      []
    );
    return raws.map(mapDocRow);
  }

  override async update(id: string, input: UpdateDocInput): Promise<DocRow | null> {
    if (input.title !== undefined && typeof input.title !== 'string') {
      throw nodeInputError('title must be a string');
    }
    assertDocFields(input);
    assertSortOrderInput(input.sortOrder);
    if (input.containerId !== undefined) await Nodes.assertPlacementParent(input.containerId);
    if (input.content !== undefined) {
      await assertNoTransclusionLoop(this.pool, { id, content: input.content });
    }
    // Placement (containerId, sortOrder) is written to nodes; title and
    // content to docs.
    const nodeSets: string[] = [];
    const nodeValues: unknown[] = [];
    if (input.containerId !== undefined) {
      nodeValues.push(input.containerId);
      nodeSets.push(`container_id = $${nodeValues.length}`);
    }
    if (input.sortOrder !== undefined) {
      nodeValues.push(input.sortOrder);
      nodeSets.push(`sort_order = $${nodeValues.length}`);
    }

    const docSets: string[] = [];
    const docValues: unknown[] = [];
    if (input.title !== undefined) {
      docValues.push(input.title);
      docSets.push(`title = $${docValues.length}`);
    }
    if (input.content !== undefined) {
      docValues.push(input.content);
      docSets.push(`content = $${docValues.length}`);
    }
    // Field edits (not a move; moveTo never touches these).
    if (input.dueAt !== undefined) {
      docValues.push(input.dueAt);
      docSets.push(`due_at = $${docValues.length}`);
    }
    if (input.assignedTo !== undefined) {
      docValues.push(input.assignedTo);
      docSets.push(`assigned_to = $${docValues.length}`);
    }
    if (input.priority !== undefined) {
      docValues.push(input.priority);
      docSets.push(`priority = $${docValues.length}`);
    }

    // last_edited_by: a title/content edit re-stamps the edit attribution
    // with the ambient actor's members.id (null when unattributed). A
    // metadata-only change (due/assignee/priority) is not an edit for this
    // purpose, and a pure move/reorder goes through moveTo, not update().
    // Never caller-settable.
    if (input.title !== undefined || input.content !== undefined) {
      docValues.push(await currentActorMemberId());
      docSets.push(`last_edited_by = $${docValues.length}`);
    }

    if (nodeSets.length === 0 && docSets.length === 0) return this.findById(id);

    if (nodeSets.length > 0) {
      nodeValues.push(id);
      await this.pool.query(
        `UPDATE ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')} SET ${nodeSets.join(', ')} WHERE id = $${nodeValues.length}`,
        nodeValues
      );
    }
    if (docSets.length > 0) {
      docValues.push(id);
      await this.pool.query(
        `UPDATE ${this.qualifiedTable} SET ${docSets.join(', ')} WHERE id = $${docValues.length}`,
        docValues
      );
    }
    await Nodes.touch(id);
    return this.findById(id);
  }

  /** Delete a doc; the shared-PK nodes row cascades the docs row away. */
  override async delete(id: string): Promise<boolean> {
    return Nodes.deleteOfType(id, NODE_KIND.DOC);
  }

  /**
   * Atomic "drop to position" — move a doc into `containerId` and place
   * it at `sortOrder`, bumping any siblings already at that slot (or
   * later) by +1. When `sortOrder` is omitted, the row lands at MAX+1 in
   * the new bucket (the "drop inside" gesture). Mirrors
   * `ContainerModel.moveTo` / `ThreadModel.moveTo` so the drag-and-drop
   * dispatcher uses the same shape of call for every kind. See
   * ContainerModel.moveTo for the CTE-atomicity rationale.
   */
  async moveTo(
    id: string,
    containerId: string | null,
    sortOrder?: number,
    movedBy?: string | null
  ): Promise<DocRow | null> {
    assertSortOrderInput(sortOrder);
    const nodesTable = `${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}`;
    // The move operates on nodes, scoped to type='doc'. The
    // parent check, sibling bump, placement write, timestamp bump and
    // placement event commit together or not at all.
    const moved = await transaction(async (tx) => {
      await Nodes.assertPlacementParent(containerId, tx);
      // Capture the pre-move container so a container-changing move records
      // a placement_events row (reorders within the same container do not).
      const fromContainerId = await Nodes.getContainerId(id, tx);
      const resolved = await this.resolveSortOrder(sortOrder, containerId, tx);
      const moveResult = await tx.query(
        // Exclude archived siblings from the bump: the
        // `archived_node_immutable_guard` trigger refuses sort_order writes
        // on archived rows, so including them would fail the move whenever
        // an archived sibling sits at or past the target slot. Archived
        // rows wait for the TTL sweeper; their sort_order affects no live view.
        `WITH siblings_bump AS (
           UPDATE ${nodesTable}
              SET sort_order = sort_order + 1
            WHERE type = 'doc'
              AND container_id IS NOT DISTINCT FROM $2
              AND id <> $1
              AND sort_order >= $3
              AND archived = false
         )
         UPDATE ${nodesTable}
            SET container_id = $2, sort_order = $3
          WHERE id = $1`,
        [id, containerId, resolved]
      );
      // A missing id updates 0 rows — nothing to touch or record.
      if ((moveResult.rowCount ?? 0) === 0) return false;
      await Nodes.touch(id, tx);
      // record() itself skips when the container did not change (pure reorder).
      await PlacementEvents.record({
        nodeId: id,
        fromContainerId,
        toContainerId: containerId,
        movedBy,
        runner: tx,
      });
      return true;
    });
    return moved ? this.findById(id) : null;
  }

  /**
   * FTS search across docs. Uses the trigger-maintained search_text column
   * and the GIN index. Returns matching docs ordered by ts_rank DESC.
   */
  async searchFts(query: string, limit = 20): Promise<DocSearchHit[]> {
    const capped = Math.min(Math.max(limit, 1), 200);
    const { rows } = await this.pool.query<DocRawRow & { rank: number }>(
      `SELECT d.id, n.container_id AS container_id, d.title, d.content,
              d.due_at, d.assigned_to, d.priority,
              d.created_by, d.last_edited_by,
              n.sort_order AS sort_order,
              d.created_at, n.updated_at,
              ts_rank(d.search_text, plainto_tsquery('english', $1))::real AS rank
       FROM ${this.qualifiedTable} d
       JOIN ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')} n ON n.id = d.id
       WHERE d.search_text @@ plainto_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $2`,
      [query, capped]
    );
    return rows.map((r) => ({ ...mapDocRow(r), rank: Number(r.rank) }));
  }
}

export const Docs = new DocModelClass();
