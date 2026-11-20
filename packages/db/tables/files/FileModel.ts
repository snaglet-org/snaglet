import type { NodeRunner } from '@snaglet/db/tables/nodes';
/**
 * FileModel — public.files.
 *
 * A `file` node mirrors a text file on a project's local disk. Its body is not
 * stored in Postgres, only the metadata to locate (project_id + relative_path),
 * dedupe (content_hash) and bound (size_bytes) it; the body is read from disk
 * on demand.
 *
 * Shared-PK with public.nodes (type='file'). Embeddings are content-addressed:
 * a file row references its chunk set via content_hash on
 * public.file_embeddings and never owns it, so deleting file rows drops
 * references only and FileEmbeddings.deleteOrphans removes unreferenced sets.
 *
 * Identity across edits is (project_id, relative_path), not the node id (see
 * `upsertByPath`). Placement and timestamps live on public.nodes; file nodes
 * hang flat under their project's home container and relative_path carries
 * the on-disk tree.
 */

import { generateId } from '@snaglet/shared/utils';
import { NODE_KIND } from '@snaglet/shared/constants';
import { Model } from '@snaglet/db/Model';
import { transaction } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { Nodes } from '@snaglet/db/tables/nodes';

export interface FileRow {
  id: string;
  projectId: string;
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
  /** Placement + timestamps live on public.nodes (SSoT); read via the JOIN. */
  containerId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input to {@link FileModelClass.upsertByPath}. Keyed on (projectId, relativePath). */
export interface UpsertFileInput {
  projectId: string;
  relativePath: string;
  contentHash: string;
  sizeBytes?: number;
  /** Home container the file node hangs under (the project's container). */
  containerId?: string | null;
}

export interface UpdateFileInput {
  contentHash?: string;
  sizeBytes?: number;
}

interface FileRawRow {
  id: string;
  project_id: string;
  relative_path: string;
  content_hash: string;
  // pg returns bigint as a string; mapFileRow narrows to number (files are
  // size-capped well within JS-safe-int range).
  size_bytes: string | number;
  container_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapFileRow(raw: FileRawRow): FileRow {
  return {
    id: raw.id,
    projectId: raw.project_id,
    relativePath: raw.relative_path,
    contentHash: raw.content_hash,
    sizeBytes: Number(raw.size_bytes),
    containerId: raw.container_id,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

class FileModelClass extends Model<FileRow, UpsertFileInput, UpdateFileInput> {
  constructor() {
    super({
      table: 'files',
      primaryKey: 'id',
      updatedAtColumn: null, // timestamps live on public.nodes (SSoT)
      createdAtColumn: null,
      columnMap: {
        projectId: 'project_id',
        relativePath: 'relative_path',
        contentHash: 'content_hash',
        sizeBytes: 'size_bytes',
        // containerId is not mapped: it lives on nodes; reads come
        // through fileSelect's JOIN, writes go through Nodes.ensure.
      },
    });
  }

  private get fileSelect(): string {
    return `
      SELECT f.id, f.project_id, f.relative_path, f.content_hash, f.size_bytes,
             n.container_id, n.created_at, n.updated_at
      FROM ${this.qualifiedTable} f
      JOIN ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')} n ON n.id = f.id
    `.trim();
  }

  override async findById(id: string): Promise<FileRow | null> {
    const raw = await this.rawQueryOne<FileRawRow>(`${this.fileSelect} WHERE f.id = $1`, [id]);
    return raw ? mapFileRow(raw) : null;
  }

  /** Look a file up by its stable identity (project + on-disk relative path). */
  async byProjectAndPath(projectId: string, relativePath: string): Promise<FileRow | null> {
    const raw = await this.rawQueryOne<FileRawRow>(
      `${this.fileSelect} WHERE f.project_id = $1 AND f.relative_path = $2`,
      [projectId, relativePath]
    );
    return raw ? mapFileRow(raw) : null;
  }

  /**
   * All file rows for a project, ordered by path. Feeds the reconciliation
   * scan's DB→disk diff (it compares relative_path + content_hash against disk).
   */
  async listByProject(projectId: string): Promise<FileRow[]> {
    const raws = await this.rawQuery<FileRawRow>(
      `${this.fileSelect} WHERE f.project_id = $1 ORDER BY f.relative_path ASC`,
      [projectId]
    );
    return raws.map(mapFileRow);
  }

  /**
   * Insert (new path) or update (existing path) a file by its stable identity.
   * Reuses the existing node id when the path is known; mints a fresh `file-…`
   * id only for genuinely new paths.
   *
   * Always bumps `nodes.updated_at`. Embedding freshness is content-addressed
   * (an updated content_hash simply references a different chunk set), but
   * callers should still skip the call when content_hash is unchanged (the
   * reconciliation scan does the hash compare) so scans stay cheap.
   *
   * A torn write (a node row without its files row, or the reverse) is
   * repaired by the next reconciliation scan, which is the correctness
   * backbone for this node type.
   */
  async upsertByPath(input: UpsertFileInput): Promise<FileRow> {
    const sizeBytes = input.sizeBytes ?? 0;
    const existing = await this.byProjectAndPath(input.projectId, input.relativePath);

    if (existing) {
      await this.pool.query(
        `UPDATE ${this.qualifiedTable}
            SET content_hash = $2, size_bytes = $3
          WHERE id = $1`,
        [existing.id, input.contentHash, sizeBytes]
      );
      await Nodes.touch(existing.id);
      const row = await this.findById(existing.id);
      if (!row) throw new Error(`FileModel.upsertByPath: row ${existing.id} missing after update`);
      return row;
    }

    const id = generateId('file');
    // Spine row and files row commit together, so a failed insert (e.g. a
    // concurrent upsert winning the project/path unique key) never leaves an
    // orphan `nodes` row behind.
    await transaction(async (tx) => {
      await Nodes.ensure(id, NODE_KIND.FILE, {
        containerId: input.containerId ?? null,
        runner: tx,
      });
      await tx.query(
        `INSERT INTO ${this.qualifiedTable}
           (id, project_id, relative_path, content_hash, size_bytes)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, input.projectId, input.relativePath, input.contentHash, sizeBytes]
      );
    });
    const row = await this.findById(id);
    if (!row) throw new Error(`FileModel.upsertByPath: row ${id} missing after insert`);
    return row;
  }

  /**
   * Count how many file rows (across all projects) reference a content hash.
   * Reference counting for the content-addressed embedding store: a chunk set
   * is garbage once this reaches zero for its hash.
   */
  async countByContentHash(contentHash: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${this.qualifiedTable} WHERE content_hash = $1`,
      [contentHash]
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Delete one file by path (offline-delete reconciliation). Drops the node +
   * files row; the content-addressed embedding reference goes with the row. */
  async deleteByPath(projectId: string, relativePath: string): Promise<boolean> {
    const existing = await this.byProjectAndPath(projectId, relativePath);
    if (!existing) return false;
    return Nodes.deleteOfType(existing.id, NODE_KIND.FILE);
  }

  /**
   * Count a project's indexed file rows. Powers the demote-from-project
   * confirmation ("this will delete N indexed file entries"), so it counts
   * this project's own rows, with no ownership redirect (satellites hold none).
   */
  async countByProject(projectId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${this.qualifiedTable} WHERE project_id = $1`,
      [projectId]
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Purge every file node for a project (gate flipped off / folder cleared).
   * Deletes the spine nodes; the FK cascade wipes the files rows. Embedding
   * chunk sets are content-addressed and shared, so they are not deleted here;
   * the GC pass (FileEmbeddings.deleteOrphans) reaps unreferenced sets.
   * Returns the number of file nodes removed.
   */
  async deleteByProject(projectId: string, runner?: NodeRunner): Promise<number> {
    const { rowCount } = await (runner ?? this.pool).query(
      `DELETE FROM public.nodes
        WHERE type = 'file'
          AND id IN (SELECT id FROM ${this.qualifiedTable} WHERE project_id = $1)`,
      [projectId]
    );
    return rowCount ?? 0;
  }

  /** Delete a single file by node id (drops the embedding reference with it). */
  override async delete(id: string): Promise<boolean> {
    return Nodes.deleteOfType(id, NODE_KIND.FILE);
  }
}

export const Files = new FileModelClass();
