/**
 * Image metadata search lifecycle against the real managed PostgreSQL database.
 *
 * Proves that human palette keyword search sees the same description/tags as
 * agent keyword search, metadata replacement is immediate, and an update never
 * leaves an old vector searchable while optional re-indexing catches up.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { closeDatabase, getDb } from '@snaglet/db';
import { Embeddings } from '@snaglet/db/tables/embeddings';
import { Images } from '@snaglet/db/tables/images';
import { Nodes } from '@snaglet/db/tables/nodes';
import { hydratePaletteHits } from '@server/services/search/paletteSearchHydration';
import { searchPaletteOnlyKind } from '@server/services/search/paletteSearchQueries';

const RUN = Date.now();
const IMAGE_ID = `image-metadata-search-${RUN}`;
const PROVIDER_ID = `image-metadata-provider-${RUN}`;
const MODEL_KEY = `image-metadata-model-${RUN}`;
const MODEL_ID = `image-metadata-model-row-${RUN}`;
const OLD_TAG = `shoreline-${RUN}`;
const NEW_TAG = `tideline-${RUN}`;
const OLD_DESCRIPTION_TOKEN = `coastalphrase${RUN}`;
const NEW_DESCRIPTION_TOKEN = `revisedphrase${RUN}`;

function vec768(value: number): number[] {
  return new Array(768).fill(value);
}

async function resultIds(query: string): Promise<string[]> {
  const hits = await searchPaletteOnlyKind({ query, kind: 'image', limit: 10 });
  return hits.map((hit) => hit.node_id);
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.query(`DELETE FROM public.nodes WHERE id = $1`, [IMAGE_ID]);
}

describe('image metadata search lifecycle', () => {
  beforeAll(async () => {
    const db = getDb();
    await db.query(
      `INSERT INTO public.providers (id, name, type)
       VALUES ($1, 'Image metadata test', 'runtime')
       ON CONFLICT (id) DO NOTHING`,
      [PROVIDER_ID]
    );
    await db.query(
      `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
       VALUES ($1, $2, $3, 'Image metadata test embedding', 'embedding', 768)
       ON CONFLICT (provider_id, model_id) DO NOTHING`,
      [MODEL_ID, PROVIDER_ID, MODEL_KEY]
    );
  });

  afterEach(cleanup);

  afterAll(async () => {
    const db = getDb();
    await db.query(`DELETE FROM public.models WHERE id = $1`, [MODEL_ID]);
    await db.query(`DELETE FROM public.providers WHERE id = $1`, [PROVIDER_ID]);
    await closeDatabase();
  });

  it('replaces keyword metadata and atomically invalidates old vectors', async () => {
    // This test exercises metadata/search only. Insert the metadata row
    // directly so it never writes a blob into the user's live image store.
    await Nodes.ensure(IMAGE_ID, 'image');
    await getDb().query(
      `INSERT INTO public.images (id, url, alt_text, metadata, description, tags)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::text[])`,
      [
        IMAGE_ID,
        'test-only-no-blob',
        'neutral-capture.png',
        JSON.stringify({ mimeType: 'image/png', sizeBytes: 0 }),
        `A quiet ${OLD_DESCRIPTION_TOKEN} reference image`,
        [OLD_TAG],
      ]
    );
    await Embeddings.replaceChunks(IMAGE_ID, MODEL_ID, 'old-image-metadata', [
      { vector: vec768(0.25), chunkIndex: 0, chunkStart: 0, chunkEnd: 10 },
    ]);

    const oldHits = await searchPaletteOnlyKind({ query: OLD_TAG, kind: 'image', limit: 10 });
    expect(oldHits.map((hit) => hit.node_id)).toContain(IMAGE_ID);
    const [hydrated] = await hydratePaletteHits('image', oldHits);
    expect(hydrated?.payload).toMatchObject({
      name: 'neutral-capture.png',
      description: `A quiet ${OLD_DESCRIPTION_TOKEN} reference image`,
      tags: [OLD_TAG],
    });
    expect(await resultIds(OLD_DESCRIPTION_TOKEN)).toContain(IMAGE_ID);
    const sourceBeforeUpdate = await Images.findMetaById(IMAGE_ID);
    expect(sourceBeforeUpdate).not.toBeNull();

    // A repeated save with identical values is a real no-op. It must not
    // discard a valid vector and force avoidable local work.
    await Images.updateMetadata(IMAGE_ID, {
      description: `A quiet ${OLD_DESCRIPTION_TOKEN} reference image`,
      tags: [OLD_TAG],
    });
    expect(await Embeddings.listByNode(IMAGE_ID, MODEL_ID)).toHaveLength(1);

    await Images.updateMetadata(IMAGE_ID, {
      description: `A ${NEW_DESCRIPTION_TOKEN} reference image`,
      tags: [NEW_TAG],
    });

    expect(await Embeddings.listByNode(IMAGE_ID, MODEL_ID)).toEqual([]);
    const staleWrite = await Embeddings.replaceChunks(
      IMAGE_ID,
      MODEL_ID,
      'in-flight-old-image-metadata',
      [{ vector: vec768(0.4), chunkIndex: 0, chunkStart: 0, chunkEnd: 10 }],
      { expectedNodeUpdatedAt: sourceBeforeUpdate!.updatedAt }
    );
    expect(staleWrite).toBeNull();
    expect(await Embeddings.listByNode(IMAGE_ID, MODEL_ID)).toEqual([]);
    expect(await resultIds(OLD_TAG)).not.toContain(IMAGE_ID);
    expect(await resultIds(OLD_DESCRIPTION_TOKEN)).not.toContain(IMAGE_ID);
    expect(await resultIds(NEW_TAG)).toContain(IMAGE_ID);
    expect(await resultIds(NEW_DESCRIPTION_TOKEN)).toContain(IMAGE_ID);

    await Embeddings.replaceChunks(IMAGE_ID, MODEL_ID, 'replacement-image-metadata', [
      { vector: vec768(0.5), chunkIndex: 0, chunkStart: 0, chunkEnd: 10 },
    ]);
    await Images.updateMetadata(IMAGE_ID, { description: null, tags: [] });

    expect(await Embeddings.listByNode(IMAGE_ID, MODEL_ID)).toEqual([]);
    expect(await resultIds(NEW_TAG)).not.toContain(IMAGE_ID);
    expect(await resultIds(NEW_DESCRIPTION_TOKEN)).not.toContain(IMAGE_ID);

    // Even an otherwise no-op blank save deletes a vector left on blank
    // metadata.
    await Embeddings.replaceChunks(IMAGE_ID, MODEL_ID, 'legacy-blank-image-metadata', [
      { vector: vec768(0.75), chunkIndex: 0, chunkStart: 0, chunkEnd: 10 },
    ]);
    await Images.updateMetadata(IMAGE_ID, { description: null, tags: [] });
    expect(await Embeddings.listByNode(IMAGE_ID, MODEL_ID)).toEqual([]);
  });
});
