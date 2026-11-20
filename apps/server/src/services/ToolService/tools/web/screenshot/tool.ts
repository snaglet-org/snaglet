import { readFile, unlink } from 'fs/promises';
import { execFile } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { generateId } from '@snaglet/shared/utils';
import { Images } from '@snaglet/db/tables/images';
import type { ToolHandler, ToolHandlerRichResult } from '@server/services/ToolService/types';
import { sniffImageMime } from '@server/services/ToolService/lib/sniffImageMime';
import { resolveAgentImageContainer } from '@server/services/ToolService/lib/resolveAgentImageContainer';
import { buildCommandEnv } from '@server/services/ToolService/lib/buildSafeEnv';
import { resolveLoginShellPath } from '@server/services/ToolService/lib/loginShellPath';
import { emitTreeNodeCreated, snapshotFromImage } from '@server/realtime/surfaces/tree';

const execFileAsync = promisify(execFile);

const MAX_VIEWPORT_DIMENSION = 8000;

function viewportDimension(raw: unknown, fallback: number): number {
  const value = Math.floor(Number(raw ?? fallback));
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(value, MAX_VIEWPORT_DIMENSION);
}

/**
 * argv for `npx playwright screenshot`. Passed to execFile, never a shell, so
 * characters URL serialization leaves intact (`$()`, `;`, `&`, quotes) reach
 * Playwright as literal URL text. The URL always starts with `http`, so it
 * cannot be read as a CLI flag.
 */
export function buildPlaywrightScreenshotArgs(
  url: string,
  width: number,
  height: number,
  outputPath: string
): string[] {
  return [
    '--yes',
    'playwright',
    'screenshot',
    `--viewport-size=${width},${height}`,
    url,
    outputPath,
  ];
}

/**
 * screenshot — capture a URL as an image and return it INLINE, immediately.
 *
 * Contract: sight is immediate, storage is automatic, and paths are never the
 * interface.
 *   - Bytes are captured via a throwaway Playwright CLI run to a private temp
 *     file, read back, and the temp file is deleted — the temp path never
 *     reaches the model — we own `tempPath` outright.
 *   - The result is returned via the `inlineImageIds` protocol (see
 *     file-read-image/tool.ts) so toolDispatch.ts attaches a real image
 *     content block to this tool_result — the model sees the pixels this
 *     same turn, no follow-up "open" call. The output text is intentionally
 *     bare ("captured, image id …") — no filesystem path, so there is
 *     nothing to tempt a re-read.
 *   - PLACEMENT: the project's Images folder, or root Images for flat runs.
 */
const tool: ToolHandler = async (input, _settings, context): Promise<ToolHandlerRichResult> => {
  const url = String(input.url ?? '');
  if (!url) throw new Error('url is required');

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`screenshot: "${url}" is not a valid URL`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`screenshot: "${url}" is not an http(s) URL`);
  }
  const safeUrl = parsedUrl.href;

  const width = viewportDimension(input.width, 1280);
  const height = viewportDimension(input.height, 800);

  const tempPath = path.join(tmpdir(), `snaglet-screenshot-${generateId('tmp')}.png`);
  let buf: Buffer | null = null;
  try {
    // npx is found through the login shell's PATH: Snaglet.app opened from the Dock
    // inherits launchd's, which has no npx. npx runs the first `playwright` on that PATH
    // or in a local node_modules/.bin, which an agent can write to, so it never gets the
    // server's own environment.
    await resolveLoginShellPath();
    await execFileAsync('npx', buildPlaywrightScreenshotArgs(safeUrl, width, height, tempPath), {
      timeout: 30000,
      env: buildCommandEnv(),
    });
    buf = await readFile(tempPath);
  } catch {
    buf = null;
  } finally {
    // eslint-disable-next-line no-restricted-syntax -- intentional: best-effort temp-file cleanup; the file legitimately may not exist when the capture failed
    await unlink(tempPath).catch(() => {});
  }

  if (!buf) {
    // Playwright unavailable/failed — fall back to a text summary so the
    // call still resolves usefully instead of hard-failing the turn.
    const res = await fetch(safeUrl, { headers: { 'User-Agent': 'Snaglet-Agent/1.0' } });
    if (!res.ok) throw new Error(`Failed to fetch ${safeUrl} (${res.status})`);
    const html = await res.text();
    const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '(no title)';
    const textContent = html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000);
    return {
      output: `Could not capture screenshot (Playwright not available). Page summary:\nTitle: ${title}\nContent: ${textContent}`,
    };
  }

  const mimeType = sniffImageMime(buf) ?? 'image/png';
  const ext = mimeType.split('/')[1] ?? 'png';
  const imageId = generateId('image');
  // Always group new captures in Images; manual moves remain independent.
  const containerId = await resolveAgentImageContainer(context?.threadId);
  const created = await Images.createImage({
    id: imageId,
    name: `screenshot-${safeHostname(parsedUrl)}-${imageId.slice(0, 8)}.${ext}`,
    containerId,
    mimeType,
    data: buf,
    sizeBytes: buf.byteLength,
    // Provenance marker: this image came from an agent tool capture (not a
    // user upload). Kept for filtering/badging; no auto-expiry (yet — see
    // the retention/purge note above).
    tags: ['tool-capture'],
  });
  // Placement changed the tree — publish it live through the sanctioned
  // surfaces/tree.ts chokepoint (same helper the images REST route uses),
  // so a container that's open in the UI picks up the new node without a
  // refetch. `Images.createImage` itself does not emit; each node-creating
  // tool handler owns its own emit call (see create-doc/thread-create/
  // create-container for the same pattern).
  emitTreeNodeCreated(snapshotFromImage(created));

  return {
    output: `captured, image id ${imageId}`,
    // Protocol shared with view_image / file_read_image: toolDispatch.ts
    // loads the listed images and appends them as image content blocks inside
    // this tool_result, and posts the standard "📸" chat render — see
    // postImageCaptureMessage in extractToolImages.ts.
    rawContent: {
      inlineImageIds: [imageId],
      note: `screenshot of ${safeUrl} saved as ${imageId}`,
    },
  };
};

function safeHostname(url: URL): string {
  return url.hostname.replace(/[^a-zA-Z0-9.-]/g, '') || 'page';
}

export default tool;
