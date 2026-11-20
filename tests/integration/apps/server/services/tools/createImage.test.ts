/**
 * create_image end to end — real DB (per-file clone), real `sharp`, and a
 * private image blob directory (SNAGLET_IMAGES_DIR) so every file the tool writes
 * or leaves behind is visible. Calls the tool's handler as an unscoped call
 * (no thread), the way a person's or a hook's call arrives.
 *
 * Covers each accepted format end to end (node placement, stored bytes,
 * returned hash), and — for every rejection — that neither an image node nor a
 * blob file survives: mismatched MIME, malformed Base64, oversized payload,
 * invalid destinations, a database failure mid-insert, a failure at COMMIT
 * after the blob was written, and a storage failure.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Containers, getDb } from '@snaglet/db';
import { Images } from '@snaglet/db/tables/images';
import { CREATE_IMAGE_MAX_BYTES } from '@server/services/ToolService/tools/media/create-image/imagePayload';
import createImage from '@server/services/ToolService/tools/media/create-image/tool';

const RUN_TAG = `createimage-${Date.now()}`;

interface ToolCallOutcome {
  isError: boolean;
  text: string;
}

interface CreatedImage {
  success: boolean;
  image_id: string;
  link: string;
  width: number;
  height: number;
  mime_type: string;
  sha256: string;
  size_bytes: number;
  container_id: string;
}

async function capture(format: 'png' | 'jpeg' | 'webp'): Promise<string> {
  const data = await sharp({
    create: { width: 6, height: 4, channels: 3, background: { r: 30, g: 90, b: 160 } },
  })
    [format]()
    .withExif({ IFD0: { Copyright: 'Test User', ImageDescription: 'private caption' } })
    .toBuffer();
  return data.toString('base64');
}

jest.setTimeout(30_000);

describe('create_image', () => {
  let imagesDir: string;
  let containerId: string;
  let imagesId: string;
  const previousImagesDir = process.env.SNAGLET_IMAGES_DIR;
  const createdNodeIds: string[] = [];

  async function callCreateImage(args: Record<string, unknown>): Promise<ToolCallOutcome> {
    try {
      const result = await createImage(args, {}, {});
      return { isError: false, text: typeof result === 'string' ? result : result.output };
    } catch (error) {
      return { isError: true, text: error instanceof Error ? error.message : String(error) };
    }
  }

  async function imageNodeCount(): Promise<number> {
    const { rows } = await getDb().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.nodes WHERE type = 'image'`
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Run a call that must fail and prove it left no node and no blob behind. */
  async function expectRejectedWithoutTrace(
    args: Record<string, unknown>,
    message: RegExp
  ): Promise<void> {
    const nodesBefore = await imageNodeCount();
    const blobsBefore = readdirSync(imagesDir);
    const outcome = await callCreateImage(args);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(message);
    expect(await imageNodeCount()).toBe(nodesBefore);
    expect(readdirSync(imagesDir)).toEqual(blobsBefore);
  }

  beforeAll(async () => {
    imagesDir = mkdtempSync(join(tmpdir(), 'snaglet-create-image-test-'));
    process.env.SNAGLET_IMAGES_DIR = imagesDir;

    const container = await Containers.create({ name: `${RUN_TAG}-screens`, category: 'project' });
    containerId = container.id;
    createdNodeIds.push(containerId);
    const images = await Containers.create({ name: 'Images', parentId: containerId });
    imagesId = images.id;
    createdNodeIds.push(imagesId);
  });

  afterAll(async () => {
    const pool = getDb();
    if (createdNodeIds.length > 0) {
      await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [createdNodeIds]);
    }
    if (previousImagesDir === undefined) delete process.env.SNAGLET_IMAGES_DIR;
    else process.env.SNAGLET_IMAGES_DIR = previousImagesDir;
    rmSync(imagesDir, { recursive: true, force: true });
  });

  it.each([
    ['image/png', 'png', 'png'],
    ['image/jpeg', 'jpeg', 'jpg'],
    ['image/webp', 'webp', 'webp'],
  ] as const)('stores a %s capture as a normal image node', async (mime, format, ext) => {
    const title = `${RUN_TAG} ${format} capture`;
    const outcome = await callCreateImage({
      title,
      parent_id: containerId,
      mime_type: mime,
      data_base64: await capture(format),
      caption: 'Captured for the test.',
    });
    expect(outcome.isError).toBe(false);
    const created = JSON.parse(outcome.text) as CreatedImage;
    createdNodeIds.push(created.image_id);

    expect(created).toMatchObject({
      success: true,
      width: 6,
      height: 4,
      mime_type: mime,
      container_id: imagesId,
      link: `[${title}](${created.image_id})`,
    });
    expect(created.image_id).toMatch(/^image-/);

    const stored = readFileSync(join(imagesDir, `${created.image_id}.${ext}`));
    expect(created.sha256).toBe(createHash('sha256').update(stored).digest('hex'));
    expect(created.size_bytes).toBe(stored.length);
    const storedMeta = await sharp(stored).metadata();
    expect(storedMeta.format).toBe(format);
    expect(storedMeta.exif).toBeUndefined();

    const row = await Images.findImageById(created.image_id);
    expect(row).toMatchObject({
      containerId: imagesId,
      name: title,
      description: 'Captured for the test.',
      mimeType: mime,
      sizeBytes: stored.length,
    });
    expect(row!.data.equals(stored)).toBe(true);
  });

  it('resolves a parent_path destination', async () => {
    const outcome = await callCreateImage({
      title: `${RUN_TAG} by path`,
      parent_path: `/${RUN_TAG}-screens`,
      mime_type: 'image/png',
      data_base64: await capture('png'),
    });
    expect(outcome.isError).toBe(false);
    const created = JSON.parse(outcome.text) as CreatedImage;
    createdNodeIds.push(created.image_id);
    expect(created.container_id).toBe(imagesId);
  });

  it('defaults an unscoped capture without parent fields to root Images', async () => {
    const outcome = await callCreateImage({
      title: `${RUN_TAG} default placement`,
      mime_type: 'image/png',
      data_base64: await capture('png'),
    });
    expect(outcome.isError).toBe(false);
    const created = JSON.parse(outcome.text) as CreatedImage;
    createdNodeIds.push(created.image_id);
    const destination = await Containers.findById(created.container_id);
    expect(destination).toMatchObject({ name: 'Images', parentId: null });
  });

  describe('rejections leave no node and no file', () => {
    it('rejects a mime_type that does not match the file signature', async () => {
      await expectRejectedWithoutTrace(
        {
          title: `${RUN_TAG} mismatch`,
          parent_id: containerId,
          mime_type: 'image/png',
          data_base64: await capture('jpeg'),
        },
        /says image\/png but the decoded bytes are image\/jpeg/
      );
    });

    it('rejects malformed Base64', async () => {
      await expectRejectedWithoutTrace(
        {
          title: `${RUN_TAG} malformed`,
          parent_id: containerId,
          mime_type: 'image/png',
          data_base64: 'iVBORw0KGgo***not-base64***',
        },
        /not valid Base64/
      );
    });

    it('rejects a payload over the decoded size limit', async () => {
      const oversized = Buffer.alloc(CREATE_IMAGE_MAX_BYTES + 1);
      Buffer.from(await capture('png'), 'base64').copy(oversized);
      await expectRejectedWithoutTrace(
        {
          title: `${RUN_TAG} oversized`,
          parent_id: containerId,
          mime_type: 'image/png',
          data_base64: oversized.toString('base64'),
        },
        /over the \d+-byte .* limit/
      );
    });

    it('rejects an SVG payload', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
      await expectRejectedWithoutTrace(
        {
          title: `${RUN_TAG} svg`,
          parent_id: containerId,
          mime_type: 'image/png',
          data_base64: Buffer.from(svg).toString('base64'),
        },
        /SVG is not accepted/
      );
    });

    it.each([
      [
        'an unknown parent_id',
        { parent_id: 'container-1111111111111-aaaaaaaaa' },
        /Container not found/,
      ],
      ['an unresolvable parent_path', { parent_path: '/no-such-container' }, /not found at path/],
      [
        'both destinations',
        { parent_id: 'container-1111111111111-aaaaaaaaa', parent_path: '/anything' },
        /exactly one destination.*not both/,
      ],
    ])('rejects %s', async (_label, destination, message) => {
      await expectRejectedWithoutTrace(
        {
          title: `${RUN_TAG} bad destination`,
          mime_type: 'image/png',
          data_base64: await capture('png'),
          ...destination,
        },
        message
      );
    });

    it('rejects an archived container', async () => {
      const archived = await Containers.create({ name: `${RUN_TAG}-archived` });
      createdNodeIds.push(archived.id);
      await getDb().query(
        `UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1`,
        [archived.id]
      );
      await expectRejectedWithoutTrace(
        {
          title: `${RUN_TAG} archived`,
          parent_id: archived.id,
          mime_type: 'image/png',
          data_base64: await capture('png'),
        },
        /is archived/
      );
    });

    it('rolls back the node when the images insert fails', async () => {
      const db = getDb();
      await db.query(`
        CREATE FUNCTION pg_temp_fail_image_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated images insert failure'; END $$`);
      await db.query(`
        CREATE TRIGGER fail_image_insert BEFORE INSERT ON public.images
        FOR EACH ROW EXECUTE FUNCTION pg_temp_fail_image_insert()`);
      try {
        await expectRejectedWithoutTrace(
          {
            title: `${RUN_TAG} db failure`,
            parent_id: containerId,
            mime_type: 'image/png',
            data_base64: await capture('png'),
          },
          /simulated images insert failure/
        );
      } finally {
        await db.query(`DROP TRIGGER fail_image_insert ON public.images`);
        await db.query(`DROP FUNCTION pg_temp_fail_image_insert()`);
      }
    });

    it('removes the written blob when the transaction fails at COMMIT', async () => {
      const db = getDb();
      await db.query(`
        CREATE FUNCTION pg_temp_fail_image_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated commit-time failure'; END $$`);
      await db.query(`
        CREATE CONSTRAINT TRIGGER fail_image_commit AFTER INSERT ON public.images
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION pg_temp_fail_image_commit()`);
      try {
        await expectRejectedWithoutTrace(
          {
            title: `${RUN_TAG} commit failure`,
            parent_id: containerId,
            mime_type: 'image/png',
            data_base64: await capture('png'),
          },
          /simulated commit-time failure/
        );
      } finally {
        await db.query(`DROP TRIGGER fail_image_commit ON public.images`);
        await db.query(`DROP FUNCTION pg_temp_fail_image_commit()`);
      }
    });

    it('rolls back the node when the blob cannot be written', async () => {
      const blocker = join(imagesDir, 'not-a-directory');
      writeFileSync(blocker, 'placeholder');
      process.env.SNAGLET_IMAGES_DIR = join(blocker, 'images');
      try {
        const nodesBefore = await imageNodeCount();
        const outcome = await callCreateImage({
          title: `${RUN_TAG} storage failure`,
          parent_id: containerId,
          mime_type: 'image/png',
          data_base64: await capture('png'),
        });
        expect(outcome.isError).toBe(true);
        expect(outcome.text).toMatch(/ENOTDIR|not a directory/i);
        expect(await imageNodeCount()).toBe(nodesBefore);
      } finally {
        process.env.SNAGLET_IMAGES_DIR = imagesDir;
        rmSync(blocker, { force: true });
      }
    });
  });
});
