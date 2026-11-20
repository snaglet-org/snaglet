/**
 * Signed plan tokens: the stale-preview guard. A token binds a reviewed plan to
 * the thread state it was measured against; `apply` re-derives both inside the
 * deleting transaction and refuses unless they match, so a message that lands
 * between preview and confirm is never swept into the delete. The token is not
 * a capability: the delete is always rebuilt from live rows. The signature stops
 * a client forging a revision to skip the check; a per-process key is enough,
 * since a restart only forces a re-preview.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConflictError, safeJsonParse } from '@snaglet/shared/utils';
import type { ThreadTimelineShape } from './threadTrimQueries';

/** Tokens older than this must be re-previewed. */
export const TRIM_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Regenerated per process. A restart drops every outstanding preview, which is
 * the fail-safe direction: worst case the user re-opens the panel.
 */
const SIGNING_KEY = randomBytes(32);

export interface TrimPlanTokenPayload {
  /** Thread the plan belongs to. */
  t: string;
  /** Fingerprint of the thread state the preview measured. */
  r: string;
  /** First retained message id. */
  f: string;
  /** Last retained message id. */
  l: string;
  /** removeSummaries. */
  s: boolean;
  /** Digest of the reviewed impact figures. */
  d: string;
  /** Issued-at, ms since epoch. */
  i: number;
}

/**
 * Fingerprint of everything that could change what a trim deletes: how many
 * messages exist, where the timeline starts and ends, and how many dependent
 * rows hang off it. Any append, any delete, any new summary moves this.
 */
export function computeThreadRevision(shape: ThreadTimelineShape): string {
  const parts = [
    String(shape.messageCount),
    shape.firstKey ? `${shape.firstKey.createdAt}|${shape.firstKey.id}` : '-',
    shape.lastKey ? `${shape.lastKey.createdAt}|${shape.lastKey.id}` : '-',
    String(shape.runCount),
    String(shape.activityCount),
    String(shape.summaryCount),
  ];
  return createHmac('sha256', SIGNING_KEY).update(parts.join('\0')).digest('hex').slice(0, 32);
}

/** Digest of the impact figures the user actually reviewed. */
export function computeImpactDigest(values: readonly number[]): string {
  return createHmac('sha256', SIGNING_KEY)
    .update(values.map((v) => String(v)).join('\0'))
    .digest('hex')
    .slice(0, 32);
}

function sign(encodedPayload: string): string {
  return createHmac('sha256', SIGNING_KEY).update(encodedPayload).digest('base64url');
}

export function issueTrimToken(payload: TrimPlanTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

/**
 * Verify the signature and decode. Returns null for anything malformed — the
 * caller turns that into a 400, never a partial delete.
 */
export function verifyTrimToken(token: string): TrimPlanTokenPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(encoded);
  // Length check first: timingSafeEqual throws on mismatched lengths.
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null;

  let json: string;
  try {
    json = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parsed = safeJsonParse<TrimPlanTokenPayload | null>(json, null);
  if (!parsed || typeof parsed !== 'object') return null;
  if (
    typeof parsed.t !== 'string' ||
    typeof parsed.r !== 'string' ||
    typeof parsed.f !== 'string' ||
    typeof parsed.l !== 'string' ||
    typeof parsed.d !== 'string' ||
    typeof parsed.s !== 'boolean' ||
    typeof parsed.i !== 'number'
  ) {
    return null;
  }
  return parsed;
}

/** Throw a 409 when the token has aged out of its review window. */
export function assertTokenFresh(payload: TrimPlanTokenPayload, now = Date.now()): void {
  if (now - payload.i > TRIM_TOKEN_TTL_MS) {
    throw new ConflictError(
      'This trim preview has expired. Nothing was deleted — reopen the preview and confirm again.'
    );
  }
}
