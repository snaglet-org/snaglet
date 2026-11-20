import { createHash } from 'node:crypto';
import { describeFlower, flowerSvgString, type CursorSpec } from '@snaglet/shared/cursor';

const AVATAR_PX = 56;
const MAX_SVG_BYTES = 12 * 1024;
const PREFIX = 'data:image/svg+xml;base64,';
const CACHE_MAX = 32;
const cache = new Map<string, AvatarUrls | undefined>();

function safe(svg: string): boolean {
  return (
    svg.startsWith('<svg') && svg.length < MAX_SVG_BYTES && !/<script|href|foreignobject/i.test(svg)
  );
}

export interface AvatarUrls {
  neutral?: string;
  stumped?: string;
  thinking?: string;
  curious?: string;
}

/** Faces the in-page cursor can show, in build order. */
const AVATAR_FACES = ['neutral', 'stumped', 'thinking', 'curious'] as const;

function urlFor(
  spec: CursorSpec,
  emotion: string,
  palette: Record<string, string>
): string | undefined {
  try {
    const svg = flowerSvgString(describeFlower(spec, emotion as never, palette), AVATAR_PX);
    return safe(svg) ? PREFIX + Buffer.from(svg, 'utf8').toString('base64') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The agent's neutral, stumped, thinking and curious faces as SVG data URLs for the in-page cursor.
 * Cached by spec + palette so they are rebuilt only when either changes. Never throws;
 * each face is independently undefined when it cannot be built safely.
 */
export function buildAvatarDataUrls(
  spec: CursorSpec,
  palette: Record<string, string>
): AvatarUrls | undefined {
  try {
    const paletteHash = createHash('sha1')
      .update(JSON.stringify(Object.entries(palette).sort(([a], [b]) => (a < b ? -1 : 1))))
      .digest('hex');
    const key = `${JSON.stringify(spec)}|${paletteHash}`;
    if (cache.has(key)) return cache.get(key);
    const built: AvatarUrls = {};
    for (const face of AVATAR_FACES) {
      const u = urlFor(spec, face, palette);
      if (u) built[face] = u;
    }
    const urls: AvatarUrls | undefined = Object.keys(built).length > 0 ? built : undefined;
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, urls);
    return urls;
  } catch {
    return undefined;
  }
}

/** The neutral face only (kept for callers that do not need the stumped one). */
export function buildAvatarDataUrl(
  spec: CursorSpec,
  palette: Record<string, string>
): string | undefined {
  return buildAvatarDataUrls(spec, palette)?.neutral;
}
