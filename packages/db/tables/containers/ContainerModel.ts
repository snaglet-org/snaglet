/**
 * ContainerModel — public.containers.
 *
 * Container node in the library hierarchy. Shared-PK with public.nodes
 * (type='container'); placement (container_id, sort_order) lives on nodes.
 * Deleting the nodes row cascades to the container row and, transitively,
 * to any docs and child containers under it.
 */

import { AppError, generateId, getErrorMessage } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';
import { CONTAINER_CATEGORIES, NODE_KIND, isContainerCategory } from '@snaglet/shared/constants';
import type { ContainerCategory } from '@snaglet/shared/constants';
import { Model } from '@snaglet/db/Model';
import { transaction } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import {
  Nodes,
  assertSortOrderInput,
  nodeInputError,
  type NodeRunner,
} from '@snaglet/db/tables/nodes';
import { PlacementEvents } from '@snaglet/db/tables/placementEvents';
import { currentActorMemberId } from '@snaglet/db/actorMember';

export interface ContainerRow {
  id: string;
  parentId: string | null;
  name: string;
  /**
   * Optional grouping category (`project` only). NULL = plain organization.
   * See packages/shared/constants/taxonomy.ts. Value space enforced by the
   * containers_category_chk DB CHECK.
   */
  category: ContainerCategory | null;
  /** Project facet — absolute local folder path (meaningful when category='project'). */
  folderPath: string | null;
  /** Project facet — git repository URL. */
  githubUrl: string | null;
  /**
   * Project facet — whether the linked folder's files are indexed. Mirrors
   * `embeddings.enabled` in the folder's snaglet.config.json; meaningless (and
   * left true) on a plain folder.
   */
  fileIndexingEnabled: boolean;
  /**
   * Free-text description. Not category-gated (meaningful on any container,
   * not just projects) — embedded as a retrieval signal and, for
   * category='project' containers, injected into project scope. NULL/empty
   * clears it.
   */
  description: string | null;
  /**
   * Creation stamp — members.id of the actor who created the container. Set
   * once at create from the resolved ambient actor; FK → members(id) ON DELETE
   * SET NULL. Not caller-settable.
   */
  createdBy: string | null;
  /**
   * Edit stamp — members.id of the actor who last modified the container
   * (name/description/category/project facets). Re-stamped on each such
   * edit; never on a pure move/reorder. FK → members(id) ON DELETE SET NULL.
   * Not caller-settable.
   */
  lastEditedBy: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  archivedAt: string | null;
}

export interface CreateContainerInput {
  id?: string;
  parentId?: string | null;
  name: string;
  category?: ContainerCategory | null;
  folderPath?: string | null;
  githubUrl?: string | null;
  fileIndexingEnabled?: boolean;
  sortOrder?: number;
}

export interface UpdateContainerInput {
  parentId?: string | null;
  name?: string;
  category?: ContainerCategory | null;
  folderPath?: string | null;
  githubUrl?: string | null;
  fileIndexingEnabled?: boolean;
  description?: string | null;
  sortOrder?: number;
}

interface ContainerRawRow {
  id: string;
  parent_id: string | null;
  name: string;
  category: ContainerCategory | null;
  folder_path: string | null;
  github_url: string | null;
  file_indexing_enabled: boolean;
  description: string | null;
  created_by: string | null;
  last_edited_by: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  archived: boolean;
  archived_at: string | null;
}

function mapContainerRow(raw: ContainerRawRow): ContainerRow {
  return {
    id: raw.id,
    parentId: raw.parent_id,
    name: raw.name,
    category: raw.category ?? null,
    folderPath: raw.folder_path ?? null,
    githubUrl: raw.github_url ?? null,
    fileIndexingEnabled: raw.file_indexing_enabled,
    description: raw.description ?? null,
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
 * Reject container field values the containers table would refuse (the
 * category CHECK, the NOT NULL boolean indexing switch) before any write, so
 * they surface as a 400 instead of a constraint error part-way through the
 * write.
 */
function assertContainerFields(input: UpdateContainerInput): void {
  if (input.name !== undefined && typeof input.name !== 'string') {
    throw nodeInputError('name must be a string');
  }
  if (input.category !== undefined && input.category !== null) {
    if (!isContainerCategory(input.category)) {
      throw nodeInputError(`category must be one of ${CONTAINER_CATEGORIES.join('|')}`);
    }
  }
  const indexing: unknown = input.fileIndexingEnabled;
  if (indexing !== undefined && typeof indexing !== 'boolean') {
    throw nodeInputError('fileIndexingEnabled must be a boolean');
  }
  assertSortOrderInput(input.sortOrder);
}

/** The `trg_nodes_container_no_cycle` trigger's refusal, raised as a plain P0001. */
function isContainerCycleError(err: unknown): boolean {
  return getErrorMessage(err, '').startsWith('nodes.container_id cycle');
}

class ContainerModelClass extends Model<ContainerRow, CreateContainerInput, UpdateContainerInput> {
  constructor() {
    super({
      table: 'containers',
      primaryKey: 'id',
      updatedAtColumn: null, // updatedAt lives on public.nodes
      columnMap: {
        parentId: 'parent_id',
        sortOrder: 'sort_order',
        folderPath: 'folder_path',
        githubUrl: 'github_url',
        fileIndexingEnabled: 'file_indexing_enabled',
      },
    });
  }

  private get containerSelect(): string {
    return `
      SELECT c.id, n.container_id AS parent_id, c.name, c.category,
             c.folder_path, c.github_url, c.file_indexing_enabled, c.description,
             c.created_by, c.last_edited_by,
             n.sort_order AS sort_order,
             c.created_at, n.updated_at, n.archived, n.archived_at
      FROM ${this.qualifiedTable} c
      JOIN ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')} n ON n.id = c.id
    `.trim();
  }

  override async create(input: CreateContainerInput): Promise<ContainerRow> {
    if (typeof input.name !== 'string') throw nodeInputError('name must be a string');
    assertContainerFields(input);
    const id = input.id ?? generateId('container');
    const parentId = input.parentId ?? null;
    // created_by: derived creation stamp — members.id of the ambient actor
    // (null when unattributed). Never taken from caller input.
    const createdBy = await currentActorMemberId();
    // The spine row, its placement, and the containers row commit together,
    // so a failed insert never leaves an orphan `nodes` row behind.
    await transaction(async (tx) => {
      await Nodes.assertPlacementParent(parentId, tx);
      await Nodes.ensure(id, NODE_KIND.CONTAINER, { runner: tx });
      const sortOrder = await this.resolveSortOrder(input.sortOrder, parentId, tx);
      // Placement (container_id, sort_order) lives on nodes.
      await tx.query(
        `UPDATE ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}
           SET container_id = $1, sort_order = $2
         WHERE id = $3`,
        [parentId, sortOrder, id]
      );
      await tx.query(
        `INSERT INTO ${this.qualifiedTable}
           (id, name, category, folder_path, github_url, file_indexing_enabled, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          input.name,
          input.category ?? null,
          input.folderPath ?? null,
          input.githubUrl ?? null,
          input.fileIndexingEnabled ?? true,
          createdBy,
        ]
      );
    });
    const row = await this.findById(id);
    if (!row) throw new Error(`ContainerModel.create: row ${id} missing after insert`);
    return row;
  }

  /**
   * Resolve the effective sort_order for an insert. Explicit caller value
   * passes through; otherwise the new container lands at the end of its
   * parent bucket via `COALESCE(MAX(sort_order), 0) + 1`. NULL parent_id
   * (root containers) is treated as its own bucket via `IS NOT DISTINCT
   * FROM` so a new root container doesn't compete with sub-containers
   * for position. Same shape as ThreadModel.resolveSortOrder — the
   * non-transactional read-then-write may produce ties under concurrent
   * inserts, which fall back to the secondary `name` sort.
   */
  private async resolveSortOrder(
    explicit: number | undefined,
    parentId: string | null,
    runner: NodeRunner = this.pool
  ): Promise<number> {
    if (explicit !== undefined) return explicit;
    // Read MAX(sort_order) from nodes, scoped to type='container'.
    const { rows } = await runner.query<{ next: number }>(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next
         FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}
        WHERE type = 'container' AND container_id IS NOT DISTINCT FROM $1`,
      [parentId]
    );
    return rows[0]?.next ?? 1;
  }

  override async findById(id: string): Promise<ContainerRow | null> {
    const raw = await this.rawQueryOne<ContainerRawRow>(`${this.containerSelect} WHERE c.id = $1`, [
      id,
    ]);
    return raw ? mapContainerRow(raw) : null;
  }

  /** List containers whose parent matches (or null for root containers). */
  async listByParent(parentId: string | null): Promise<ContainerRow[]> {
    const where = parentId === null ? 'n.container_id IS NULL' : 'n.container_id = $1';
    const values = parentId === null ? [] : [parentId];
    const raws = await this.rawQuery<ContainerRawRow>(
      `${this.containerSelect} WHERE ${where} ORDER BY n.sort_order, c.name`,
      values
    );
    return raws.map(mapContainerRow);
  }

  /** Top-level containers (parent_id IS NULL). */
  async listRoots(): Promise<ContainerRow[]> {
    return this.listByParent(null);
  }

  /**
   * All active containers in one query, returned in (parent_id, sort_order, name)
   * order. Excludes archived rows (`nodes.archived = true`) — archived rows
   * are queried via the dedicated `/api/archive/*` endpoints, not this
   * tree-rendering path.
   */
  async listAllOrdered(): Promise<ContainerRow[]> {
    const raws = await this.rawQuery<ContainerRawRow>(
      `${this.containerSelect}
        WHERE n.archived = false
        ORDER BY n.container_id NULLS FIRST, n.sort_order, c.name`,
      []
    );
    return raws.map(mapContainerRow);
  }

  override async update(id: string, input: UpdateContainerInput): Promise<ContainerRow | null> {
    assertContainerFields(input);
    if (input.parentId !== undefined) await Nodes.assertPlacementParent(input.parentId);
    // Project category guard. A plain folder may be promoted to a project
    // (NULL → 'project'): nothing scopes to a folder, so there is nothing to
    // rehome. A project can never be demoted: thread and table project scopes
    // point at it (the database refuses it too, in
    // trg_containers_project_category_guard). Every server-side category
    // change goes through this method, so the refusal is raised here as a
    // clean 400 before any write.
    if (input.category !== undefined) {
      const existing = await this.findById(id);
      if (!existing) return null;
      if (existing.category === 'project' && input.category !== 'project') {
        throw nodeInputError(
          `Container ${id} category cannot change out of 'project': its threads and tables are scoped to it; move or delete them first`
        );
      }
    }

    // Placement (parentId, sortOrder) is written to nodes; name, description
    // and facets to containers.
    const nodeSets: string[] = [];
    const nodeValues: unknown[] = [];
    if (input.parentId !== undefined) {
      nodeValues.push(input.parentId);
      nodeSets.push(`container_id = $${nodeValues.length}`);
    }
    if (input.sortOrder !== undefined) {
      nodeValues.push(input.sortOrder);
      nodeSets.push(`sort_order = $${nodeValues.length}`);
    }

    const containerSets: string[] = [];
    const containerValues: unknown[] = [];
    if (input.name !== undefined) {
      containerValues.push(input.name);
      containerSets.push(`name = $${containerValues.length}`);
    }
    if (input.description !== undefined) {
      containerValues.push(input.description);
      containerSets.push(`description = $${containerValues.length}`);
    }
    if (input.category !== undefined) {
      containerValues.push(input.category);
      containerSets.push(`category = $${containerValues.length}`);
    }
    if (input.folderPath !== undefined) {
      containerValues.push(input.folderPath);
      containerSets.push(`folder_path = $${containerValues.length}`);
    }
    if (input.githubUrl !== undefined) {
      containerValues.push(input.githubUrl);
      containerSets.push(`github_url = $${containerValues.length}`);
    }
    if (input.fileIndexingEnabled !== undefined) {
      containerValues.push(input.fileIndexingEnabled);
      containerSets.push(`file_indexing_enabled = $${containerValues.length}`);
    }
    // last_edited_by: a content edit (name, description, category, project
    // facets) re-stamps the edit attribution with the ambient actor's
    // members.id (null when unattributed). A pure move/reorder goes through
    // moveTo, not update(), so it never re-stamps. Never caller-settable.
    const isContentEdit =
      input.name !== undefined ||
      input.description !== undefined ||
      input.category !== undefined ||
      input.folderPath !== undefined ||
      input.githubUrl !== undefined ||
      input.fileIndexingEnabled !== undefined;
    if (isContentEdit) {
      containerValues.push(await currentActorMemberId());
      containerSets.push(`last_edited_by = $${containerValues.length}`);
    }

    if (nodeSets.length === 0 && containerSets.length === 0) return this.findById(id);

    if (nodeSets.length > 0) {
      nodeValues.push(id);
      await this.pool.query(
        `UPDATE ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')} SET ${nodeSets.join(', ')} WHERE id = $${nodeValues.length}`,
        nodeValues
      );
    }
    if (containerSets.length > 0) {
      containerValues.push(id);
      await this.pool.query(
        `UPDATE ${this.qualifiedTable} SET ${containerSets.join(', ')} WHERE id = $${containerValues.length}`,
        containerValues
      );
    }
    await Nodes.touch(id);

    return this.findById(id);
  }

  /** Delete a container subtree through public.nodes using the supplied transaction runner. */
  override async delete(id: string, runner?: NodeRunner): Promise<boolean> {
    return Nodes.deleteOfType(id, NODE_KIND.CONTAINER, runner);
  }

  /**
   * Atomic "drop to position" — move a container under `parentId` and
   * place it at `sortOrder`, bumping any siblings already at that slot
   * (or later) by +1. When `sortOrder` is omitted, the row lands at MAX+1
   * in the new bucket (the "drop inside" gesture).
   *
   * Both the bump and the row-update run inside one statement via a CTE,
   * so other readers either see the old state or the new state — never a
   * snapshot with the target inserted but the bumps not yet applied. The
   * two UPDATEs reference the same snapshot, so the bump's `id <> $1`
   * exclusion correctly leaves the target alone (we set it ourselves in
   * the outer UPDATE).
   *
   * `IS NOT DISTINCT FROM` handles NULL parent_id ("root bucket") as
   * its own scope without contaminating other root-level rows.
   */
  async moveTo(
    id: string,
    parentId: string | null,
    sortOrder?: number,
    movedBy?: string | null
  ): Promise<ContainerRow | null> {
    assertSortOrderInput(sortOrder);
    const nodesTable = `${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}`;
    let moved: boolean;
    try {
      // The move operates on nodes, scoped to type='container'.
      // The parent check, sibling bump, placement write, timestamp bump and
      // placement event commit together or not at all.
      moved = await transaction(async (tx) => {
        await Nodes.assertPlacementParent(parentId, tx);
        // Capture the pre-move container so a container-changing move can be
        // recorded in placement_events (reorders within the same parent are not).
        const fromContainerId = await Nodes.getContainerId(id, tx);
        const resolved = await this.resolveSortOrder(sortOrder, parentId, tx);
        const moveResult = await tx.query(
          // See DocModel.moveTo: skip archived siblings or the immutable
          // guard 500s the whole move when one lives at/past the target slot.
          `WITH siblings_bump AS (
             UPDATE ${nodesTable}
                SET sort_order = sort_order + 1
              WHERE type = 'container'
                AND container_id IS NOT DISTINCT FROM $2
                AND id <> $1
                AND sort_order >= $3
                AND archived = false
           )
           UPDATE ${nodesTable}
              SET container_id = $2, sort_order = $3
            WHERE id = $1`,
          [id, parentId, resolved]
        );
        // A missing id updates 0 rows — nothing to touch or record.
        if ((moveResult.rowCount ?? 0) === 0) return false;
        await Nodes.touch(id, tx);
        // record() itself skips when the container did not change (pure reorder).
        await PlacementEvents.record({
          nodeId: id,
          fromContainerId,
          toContainerId: parentId,
          movedBy,
          runner: tx,
        });
        return true;
      });
    } catch (err) {
      if (isContainerCycleError(err)) {
        throw new AppError(
          `Cannot move container ${id} into itself or one of its own descendants`,
          ErrorCode.VALIDATION_ERROR,
          400
        );
      }
      throw err;
    }
    return moved ? this.findById(id) : null;
  }
}

export const Containers = new ContainerModelClass();
