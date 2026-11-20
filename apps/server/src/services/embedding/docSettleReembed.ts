/**
 * doc_edit_state — per-doc bookkeeping that keeps doc search fresh after human
 * edits.
 *
 * Doc content autosave fires per keystroke, so the human-edit path does not
 * re-embed on every save (that would spam the embedding model). Instead
 * `stampDocEdit` records the latest content hash and the edit time (the idle
 * clock); the embedding worker's settle sweep (`sweepSettledDocReembeds`)
 * later re-embeds the doc once it has changed since last embedded and gone
 * quiet. Agent doc writes are discrete, complete edits — they embed inline and
 * pre-advance the last-embedded hash so this sweep skips them.
 *
 * `content_hash` uses the same blob the embeddings pipeline hashes, so a doc
 * embedded inline is a no-op here. The "last embedded" hash is stored in the
 * `last_logged_hash` column; the table's editor columns are not read.
 */

import { createHash } from 'crypto';
import { getDb } from '@snaglet/db';
import { getErrorMessage } from '@snaglet/shared/utils';
import { docBlobForEmbedding, embedDocNow } from '@server/services/embedding/embedDoc';
import { logger } from '@server/config/logger';

/** A doc must be quiet (no content edit) this long before it counts settled. */
const SETTLE_IDLE_SECONDS = 60;
const SETTLE_BATCH = 200;

/** sha256 of the same blob the embeddings pipeline hashes. */
function hashDocContent(
  title: string | null | undefined,
  content: string | null | undefined
): string {
  return createHash('sha256').update(docBlobForEmbedding(title, content)).digest('hex');
}

interface StampOptions {
  /**
   * Set when the doc was already embedded inline (agent edits are discrete
   * complete writes that embed immediately). Pre-advances `last_logged_hash`
   * so the settle sweep won't re-embed the same content.
   */
  alreadyEmbedded?: boolean;
}

/**
 * Record a content edit's settle-state. Called on every doc content save
 * (human autosave and agent edit). Best-effort — never throws.
 */
export async function stampDocEdit(
  docId: string,
  title: string | null | undefined,
  content: string | null | undefined,
  opts: StampOptions = {}
): Promise<void> {
  try {
    const hash = hashDocContent(title, content);
    await getDb().query(
      `INSERT INTO public.doc_edit_state
         (doc_id, last_content_edit_at, content_hash, last_logged_hash)
       VALUES ($1, now(), $2, $3)
       ON CONFLICT (doc_id) DO UPDATE SET
         last_content_edit_at = now(),
         content_hash         = EXCLUDED.content_hash,
         last_logged_hash     = COALESCE(EXCLUDED.last_logged_hash, public.doc_edit_state.last_logged_hash)`,
      [docId, hash, opts.alreadyEmbedded ? hash : null]
    );
  } catch (err) {
    logger.warn('[docSettleReembed] stampDocEdit failed', {
      docId,
      err: getErrorMessage(err),
    });
  }
}

interface SettledRow {
  doc_id: string;
  title: string;
  content: string;
  content_hash: string;
}

/**
 * Re-embed each settled human doc edit, then advance its last-embedded marker.
 * A doc qualifies once its content has changed since last embedded AND it has
 * been quiet (no content edit) for at least the idle window. Returns the number
 * of docs re-embedded. Best-effort per row.
 */
export async function sweepSettledDocReembeds(): Promise<number> {
  const db = getDb();
  const { rows } = await db.query<SettledRow>(
    `SELECT s.doc_id, d.title, d.content, s.content_hash
       FROM public.doc_edit_state s
       JOIN public.docs d ON d.id = s.doc_id
      WHERE s.content_hash IS DISTINCT FROM s.last_logged_hash
        AND s.last_content_edit_at IS NOT NULL
        AND s.last_content_edit_at < now() - ($1 * interval '1 second')
      LIMIT $2`,
    [SETTLE_IDLE_SECONDS, SETTLE_BATCH]
  );

  let processed = 0;
  for (const row of rows) {
    try {
      // The settled signal drives the embed refresh deferred by autosave.
      embedDocNow(row.doc_id, row.title, row.content);
      // Advance to the exact hash we just embedded; a newer edit (different
      // hash) stays pending and is picked up next sweep once it too settles.
      await db.query(`UPDATE public.doc_edit_state SET last_logged_hash = $2 WHERE doc_id = $1`, [
        row.doc_id,
        row.content_hash,
      ]);
      processed += 1;
    } catch (err) {
      logger.warn('[docSettleReembed] settle-sweep row failed', {
        docId: row.doc_id,
        err: getErrorMessage(err),
      });
    }
  }
  return processed;
}
