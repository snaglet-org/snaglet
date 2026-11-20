/**
 * ImageModel — public.images.
 *
 * `images.url` holds a storage key into the on-disk blob store
 * (`<SNAGLET_HOME>/images/<key>`, see imageStore.ts); older rows may instead hold
 * an inline `data:<mime>;base64,…` URL, and findImageById picks the byte
 * source per row. `rename` changes the name (`alt_text`) and the file's key
 * together. Placement (container_id, sort_order) lives on public.nodes;
 * reads join nodes and create/move write to nodes.
 *
 * The external API presents `{ id, name, mimeType, data: Buffer, sizeBytes,
 * createdAt, updatedAt }` rows; `findImageById` loads the bytes.
 */

import { Model } from '@snaglet/db/Model';
import { transaction } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { Nodes, type NodeRunner } from '@snaglet/db/tables/nodes';
import { PlacementEvents } from '@snaglet/db/tables/placementEvents';
import { NODE_KIND } from '@snaglet/shared/constants';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  abandonImageBlobRename,
  finishImageBlobRename,
  hasImageBlob,
  isStorageKey,
  locateImageBlob,
  readImageBlob,
  removeImageBlob,
  stageImageBlobRename,
  storageKeyExt,
  storageKeyFor,
  storageKeyForName,
  writeImageBlob,
  type BlobRenameStage,
} from './imageStore';

export interface ImageRow {
  id: string;
  containerId: string | null;
  name: string;
  description: string | null;
  tags: string[];
  mimeType: string;
  data: Buffer;
  /** Blob-store key the bytes are read from; null when they live inline in the row. */
  storageKey: string | null;
  sizeBytes: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Outcome of {@link ImageModelClass.rename}. `conflict` means the image no
 * longer has the name the caller expected, or changed while the rename ran.
 */
export type ImageRenameOutcome =
  | { status: 'renamed' | 'unchanged'; image: ImageListRow }
  | { status: 'conflict'; currentName: string }
  | { status: 'missing' };

/**
 * Renames of one image run one at a time: the blob halves of a rename touch
 * names a concurrent rename of the same image could also be using.
 */
const renameQueues = new Map<string, Promise<unknown>>();

function serializeRename<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = renameQueues.get(id) ?? Promise.resolve();
  const next = previous.then(work);
  // The queue waits for each rename to settle; its caller gets the result.
  const settled = Promise.allSettled([next]);
  renameQueues.set(id, settled);
  void settled.then(() => {
    if (renameQueues.get(id) === settled) renameQueues.delete(id);
  });
  return next;
}

export interface ImageListRow {
  id: string;
  containerId: string | null;
  name: string;
  description: string | null;
  tags: string[];
  mimeType: string;
  sizeBytes: number;
  sortOrder: number;
  /** True while the image sits in the archive. */
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateImageInput {
  id: string;
  containerId?: string | null;
  name: string;
  description?: string | null;
  tags?: string[];
  mimeType: string;
  data: Buffer;
  sizeBytes: number;
  sortOrder?: number;
}

function parseDataUrl(url: string): { mimeType: string; data: Buffer } | null {
  const m = url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  return { mimeType: m[1]!, data: Buffer.from(m[2]!, 'base64') };
}

interface RawImageRow {
  id: string;
  url: string;
  alt_text: string | null;
  metadata: Record<string, unknown> | null;
  description: string | null;
  tags: string[] | null;
  container_id: string | null;
  sort_order: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

function rawToListRow(raw: Omit<RawImageRow, 'url'> & { url?: string }): ImageListRow {
  const meta = raw.metadata ?? {};
  return {
    id: raw.id,
    containerId: raw.container_id,
    name: raw.alt_text ?? '',
    description: raw.description,
    tags: raw.tags ?? [],
    mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : 'application/octet-stream',
    sizeBytes: typeof meta.sizeBytes === 'number' ? meta.sizeBytes : 0,
    sortOrder: raw.sort_order,
    archived: raw.archived,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

class ImageModelClass extends Model<ImageRow, CreateImageInput> {
  constructor() {
    super({ table: 'images', primaryKey: 'id', updatedAtColumn: null });
  }

  private get listSelect(): string {
    return `
      SELECT i.id, i.alt_text, i.metadata, i.description, i.tags,
             n.container_id, n.sort_order, n.archived,
             n.created_at, n.updated_at
        FROM ${this.qualifiedTable} i
        JOIN ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')} n ON n.id = i.id
    `.trim();
  }

  /**
   * List images without the binary payload, newest-first by node timestamp.
   * Excludes the heavy `url` column (data URL) from the projection.
   */
  async listImages(): Promise<ImageListRow[]> {
    const { rows } = await this.pool.query<Omit<RawImageRow, 'url'>>(
      `${this.listSelect}
        WHERE n.archived = false
        ORDER BY n.created_at DESC, n.updated_at DESC`
    );
    return rows.map(rawToListRow);
  }

  /**
   * All active images in one query, returned in (container_id, sort_order)
   * order — mirrors `Docs.listAllOrdered` / `Threads.listAllOrdered` for the
   * tree builder.
   */
  async listAllOrdered(): Promise<ImageListRow[]> {
    const { rows } = await this.pool.query<Omit<RawImageRow, 'url'>>(
      `${this.listSelect}
        WHERE n.archived = false
        ORDER BY n.container_id NULLS FIRST, n.sort_order, n.created_at DESC`
    );
    return rows.map(rawToListRow);
  }

  /**
   * Find an image by id, including its binary payload. Returns null if
   * either the row doesn't exist or its `url` isn't a parseable data URL
   * (defensive — flagging schema drift loudly via null rather than
   * returning a half-row).
   */
  async findImageById(id: string): Promise<ImageRow | null> {
    const { rows } = await this.pool.query<RawImageRow>(
      `SELECT i.id, i.url, i.alt_text, i.metadata, i.description, i.tags,
              n.container_id, n.sort_order, n.archived,
              n.created_at, n.updated_at
         FROM ${this.qualifiedTable} i
         JOIN ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')} n ON n.id = i.id
        WHERE i.id = $1
        LIMIT 1`,
      [id]
    );
    const raw = rows[0];
    if (!raw) return null;

    const meta = raw.metadata ?? {};
    const metaMime = typeof meta.mimeType === 'string' ? meta.mimeType : undefined;

    // Bytes come from one of two sources, chosen per-row: an inline `data:`
    // URL (older rows) or the on-disk blob store keyed by `images.url`.
    let mimeType: string;
    let data: Buffer;
    let storageKey: string | null = null;
    if (raw.url.startsWith('data:')) {
      const parsed = parseDataUrl(raw.url);
      if (!parsed) return null; // unparseable data URL → loud null (schema drift)
      mimeType = parsed.mimeType;
      data = parsed.data;
    } else {
      mimeType = metaMime ?? 'application/octet-stream';
      storageKey = raw.url;
      let bytes = await readImageBlob(storageKey);
      if (!bytes) {
        // The row may name the file before a rename (a restored backup).
        const found = await locateImageBlob(raw.id, storageKeyExt(storageKey, mimeType));
        if (found) {
          storageKey = found;
          bytes = await readImageBlob(found);
        }
      }
      data = bytes ?? Buffer.alloc(0);
    }

    return {
      id: raw.id,
      containerId: raw.container_id,
      name: raw.alt_text ?? '',
      description: raw.description,
      tags: raw.tags ?? [],
      mimeType,
      data,
      storageKey,
      sizeBytes: typeof meta.sizeBytes === 'number' ? meta.sizeBytes : data.length,
      sortOrder: raw.sort_order,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  /**
   * Resolve the effective sort_order for an insert. Explicit caller value
   * passes through; otherwise the new image lands at the end of its
   * container bucket via `COALESCE(MAX(sort_order), 0) + 1`. Mirrors
   * DocModel.resolveSortOrder.
   */
  private async resolveSortOrder(
    explicit: number | undefined,
    containerId: string | null,
    runner: NodeRunner = this.pool
  ): Promise<number> {
    if (explicit !== undefined) return explicit;
    const { rows } = await runner.query<{ next: number }>(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next
         FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}
        WHERE type = 'image' AND container_id IS NOT DISTINCT FROM $1`,
      [containerId]
    );
    return rows[0]?.next ?? 1;
  }

  /**
   * Insert a new image: the public.nodes row (type='image'), its placement
   * (container_id, sort_order), the public.images row, and finally the blob —
   * all inside one transaction. The blob is written last so a failed statement
   * rolls back before any bytes reach disk; if the blob write or the COMMIT
   * itself fails, the blob is removed again. Either the node and its bytes
   * both exist, or neither does. Returns the list-shape row (metadata without
   * binary).
   */
  async createImage(input: CreateImageInput): Promise<ImageListRow> {
    const key = storageKeyFor(input.id, input.mimeType);
    const metadata = { mimeType: input.mimeType, sizeBytes: input.sizeBytes };
    const containerId = input.containerId ?? null;
    const tags = input.tags ?? [];
    const nodesTable = `${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}`;
    let blobAttempted = false;

    try {
      return await transaction(async (tx) => {
        await Nodes.assertPlacementParent(containerId, tx);
        await Nodes.ensure(input.id, NODE_KIND.IMAGE, { runner: tx });
        const sortOrder = await this.resolveSortOrder(input.sortOrder, containerId, tx);
        // Same bump-then-set CTE as DocModel.moveTo: an explicit sortOrder
        // (drop-between-rows) shifts siblings at/past the slot by +1 so the
        // new image lands exactly where the user pointed. The append path
        // (resolved MAX+1) matches no siblings, so the bump is a no-op there.
        // Archived rows are excluded: the archived_node_immutable_guard
        // trigger rejects sort_order writes on them.
        await tx.query(
          `WITH siblings_bump AS (
             UPDATE ${nodesTable}
                SET sort_order = sort_order + 1
              WHERE type = 'image'
                AND container_id IS NOT DISTINCT FROM $1
                AND id <> $3
                AND sort_order >= $2
                AND archived = false
           )
           UPDATE ${nodesTable}
              SET container_id = $1, sort_order = $2
            WHERE id = $3`,
          [containerId, sortOrder, input.id]
        );
        await tx.query(
          `INSERT INTO ${this.qualifiedTable} (id, url, alt_text, metadata, description, tags)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6::text[])`,
          [input.id, key, input.name, JSON.stringify(metadata), input.description ?? null, tags]
        );
        const { rows } = await tx.query<Omit<RawImageRow, 'url'>>(
          `${this.listSelect} WHERE i.id = $1 LIMIT 1`,
          [input.id]
        );
        if (!rows[0]) {
          throw new Error(`ImageModel.createImage: row ${input.id} missing after insert`);
        }
        blobAttempted = true;
        await writeImageBlob(key, input.data);
        return rawToListRow(rows[0]);
      });
    } catch (err) {
      if (blobAttempted) {
        // The create failure is what the caller must see; a failed cleanup is
        // only logged so it cannot mask it.
        await removeImageBlob(key).catch((cleanupErr: unknown) => {
          console.warn(
            `[images] could not remove blob ${key} after a failed create: ${getErrorMessage(cleanupErr)}`
          );
        });
      }
      throw err;
    }
  }

  /**
   * Atomically move an image to a new container and/or position. Mirrors
   * `DocModel.moveTo` / `ContainerModel.moveTo` so the drag-and-drop
   * dispatcher uses the same call shape for every kind. Placement
   * (container_id, sort_order) lives on nodes (SSoT); the bump-then-set CTE
   * shifts siblings at/after the target slot by +1 so the drop lands exactly
   * where the user pointed. An omitted sortOrder appends to the end of the
   * destination bucket (resolveSortOrder → MAX+1). Returns null if missing.
   */
  async moveTo(
    id: string,
    containerId: string | null,
    sortOrder?: number,
    movedBy?: string | null
  ): Promise<ImageListRow | null> {
    const nodesTable = `${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}`;
    // The parent check, sibling bump, placement write, timestamp bump and
    // placement event commit together or not at all.
    const moved = await transaction(async (tx) => {
      await Nodes.assertPlacementParent(containerId, tx);
      // Capture the pre-move container so a container-changing move records a
      // placement_events row (reorders within the same container do not).
      const fromContainerId = await Nodes.getContainerId(id, tx);
      const resolved = await this.resolveSortOrder(sortOrder, containerId, tx);
      const moveResult = await tx.query(
        // Exclude archived siblings from the bump: the
        // `archived_node_immutable_guard` trigger refuses sort_order writes on
        // archived rows, so leaving them in the WHERE clause would 500 the move
        // whenever an archived sibling sits at/past the target slot.
        `WITH siblings_bump AS (
           UPDATE ${nodesTable}
              SET sort_order = sort_order + 1
            WHERE type = 'image'
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
    if (!moved) return null;
    return this.findMetaById(id);
  }

  async findMetaById(id: string): Promise<ImageListRow | null> {
    const { rows } = await this.pool.query<Omit<RawImageRow, 'url'>>(
      `${this.listSelect} WHERE i.id = $1 LIMIT 1`,
      [id]
    );
    return rows[0] ? rawToListRow(rows[0]) : null;
  }

  /**
   * Update an image's searchable metadata. `description` uses key-present
   * semantics (null clears, undefined leaves untouched); `tags` replaces the
   * whole set. The metadata write, node timestamp bump, and deletion of every
   * old image vector happen in one transaction: stale metadata must never stay
   * searchable while an optional indexing pass catches up. A later automatic
   * or manual embedding pass may write the replacement. Returns the list-shape
   * row, or null when the image doesn't exist.
   */
  async updateMetadata(
    id: string,
    patch: { description?: string | null; tags?: string[] }
  ): Promise<ImageListRow | null> {
    const sets: string[] = [];
    const changed: string[] = [];
    const values: unknown[] = [];
    if (patch.description !== undefined) {
      values.push(patch.description);
      sets.push(`description = $${values.length}`);
      changed.push(`description IS DISTINCT FROM $${values.length}`);
    }
    if (patch.tags !== undefined) {
      values.push(patch.tags);
      sets.push(`tags = $${values.length}::text[]`);
      changed.push(`tags IS DISTINCT FROM $${values.length}::text[]`);
    }

    if (sets.length > 0) {
      const outcome = await transaction(async (client) => {
        values.push(id);
        const { rowCount } = await client.query(
          `UPDATE ${this.qualifiedTable}
              SET ${sets.join(', ')}
            WHERE id = $${values.length}
              AND (${changed.join(' OR ')})`,
          values
        );
        if (!rowCount) {
          const existing = await client.query<{ description: string | null; tags: string[] }>(
            `SELECT description, tags FROM ${this.qualifiedTable} WHERE id = $1 LIMIT 1`,
            [id]
          );
          const row = existing.rows[0];
          if (!row) return 'missing';
          // An existing database may already contain a vector for an image whose
          // metadata is blank. Repeating the blank save is still the repair
          // signal even though the column values themselves are unchanged.
          if (!row.description?.trim() && row.tags.length === 0) {
            await client.query(`DELETE FROM public.embeddings WHERE node_id = $1`, [id]);
          }
          return 'unchanged';
        }
        await Nodes.touch(id, client);
        await client.query(`DELETE FROM public.embeddings WHERE node_id = $1`, [id]);
        return 'updated';
      });
      if (outcome === 'missing') return null;
    }

    return this.findMetaById(id);
  }

  /**
   * Rename an image and its stored file. `name` must already be trimmed and
   * valid (see imageNameProblem); `expectedName`, when given, is the name the
   * caller last saw, and a different current name is a `conflict`.
   *
   * Ordering keeps the DB pointing at a file that exists at every instant:
   * the bytes first gain the new key while the old key stays, then the name,
   * key, node timestamp and vector invalidation (the name is part of an
   * image's embedding text) commit together, and only then is the old key
   * removed. A failed commit removes the new key instead. A file name is only
   * ever removed while the row points elsewhere. Rows whose bytes live inline
   * (`data:` URLs) keep them inline and change only the name.
   */
  async rename(
    id: string,
    name: string,
    options: { expectedName?: string } = {}
  ): Promise<ImageRenameOutcome> {
    if (!name.trim()) throw new Error('ImageModel.rename: name must not be empty');
    return serializeRename(id, () => this.renameNow(id, name, options.expectedName));
  }

  private async readNameAndKey(
    id: string,
    runner: NodeRunner = this.pool
  ): Promise<{ name: string; url: string; mimeType: string } | null> {
    const { rows } = await runner.query<Pick<RawImageRow, 'url' | 'alt_text' | 'metadata'>>(
      `SELECT url, alt_text, metadata FROM ${this.qualifiedTable} WHERE id = $1 LIMIT 1${
        runner === this.pool ? '' : ' FOR UPDATE'
      }`,
      [id]
    );
    const row = rows[0];
    if (!row) return null;
    const meta = row.metadata ?? {};
    return {
      name: row.alt_text ?? '',
      url: row.url,
      mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : 'application/octet-stream',
    };
  }

  private async renameNow(
    id: string,
    name: string,
    expectedName: string | undefined
  ): Promise<ImageRenameOutcome> {
    const current = await this.readNameAndKey(id);
    if (!current) return { status: 'missing' };
    if (expectedName !== undefined && current.name !== expectedName) {
      return { status: 'conflict', currentName: current.name };
    }
    if (current.name === name) {
      const image = await this.findMetaById(id);
      return image ? { status: 'unchanged', image } : { status: 'missing' };
    }

    // `fromKey` is what the row says; `sourceKey` is where the bytes are, which
    // differs only when the row names a file that is gone (a restored backup).
    const fromKey = current.url;
    let sourceKey = fromKey;
    if (isStorageKey(fromKey) && !(await hasImageBlob(fromKey))) {
      sourceKey = (await locateImageBlob(id, storageKeyExt(fromKey, current.mimeType))) ?? fromKey;
    }
    const nextKey = isStorageKey(fromKey)
      ? storageKeyForName(id, name, storageKeyExt(sourceKey, current.mimeType))
      : fromKey;
    const stage: BlobRenameStage | null =
      nextKey === sourceKey ? null : await stageImageBlobRename(sourceKey, nextKey);
    const toKey = stage === 'missing' ? fromKey : nextKey;

    let outcome: 'renamed' | 'conflict' | 'missing';
    let latestName = current.name;
    try {
      outcome = await transaction<'renamed' | 'conflict' | 'missing'>(async (tx) => {
        const locked = await this.readNameAndKey(id, tx);
        if (!locked) return 'missing';
        latestName = locked.name;
        if (locked.url !== fromKey || locked.name !== current.name) return 'conflict';
        await tx.query(`UPDATE ${this.qualifiedTable} SET alt_text = $2, url = $3 WHERE id = $1`, [
          id,
          name,
          toKey,
        ]);
        await Nodes.touch(id, tx);
        await tx.query(`DELETE FROM public.embeddings WHERE node_id = $1`, [id]);
        return 'renamed';
      });
    } catch (err) {
      if (stage)
        await this.retireKeyUnlessUsed(id, toKey, () => abandonImageBlobRename(toKey, stage));
      throw err;
    }

    if (outcome !== 'renamed') {
      if (stage)
        await this.retireKeyUnlessUsed(id, toKey, () => abandonImageBlobRename(toKey, stage));
      return outcome === 'missing'
        ? { status: 'missing' }
        : { status: 'conflict', currentName: latestName };
    }
    if (stage) {
      await this.retireKeyUnlessUsed(id, sourceKey, () =>
        finishImageBlobRename(sourceKey, toKey, stage)
      );
    }
    const image = await this.findMetaById(id);
    return image ? { status: 'renamed', image } : { status: 'missing' };
  }

  /**
   * Run a cleanup that removes or renames away `key`, unless the row points
   * at it now. A cleanup failure is logged, not thrown: the rename itself
   * already succeeded or failed, and a stray extra name loses nothing.
   */
  private async retireKeyUnlessUsed(
    id: string,
    key: string,
    cleanup: () => Promise<void>
  ): Promise<void> {
    try {
      const row = await this.readNameAndKey(id);
      if (row?.url === key) return;
      await cleanup();
    } catch (err) {
      console.warn(`[images] could not tidy blob ${key} after a rename: ${getErrorMessage(err)}`);
    }
  }
}

export const Images = new ImageModelClass();
