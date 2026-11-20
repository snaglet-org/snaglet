/**
 * Admin embedding routes — manual control for the base embedding pipeline.
 *
 * GET /api/admin/embeddings/status — base embedding + links counts.
 *
 * Manual reembed endpoints for docs/blocks/containers have not been wired up
 * yet.
 */

import { Router } from 'express';
import { getDb } from '@snaglet/db/db';
import { getErrorMessage } from '@snaglet/shared/utils';

const router = Router();

router.get('/status', async (_req, res) => {
  try {
    const pool = getDb();
    const { rows } = await pool.query<{
      base_embeddings: string;
      total_links: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM public.embeddings) as base_embeddings,
        (SELECT COUNT(*) FROM public.links) as total_links
    `);

    const counts = rows[0];
    res.json({
      base_embeddings: Number(counts.base_embeddings),
      total_links: Number(counts.total_links),
    });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err, 'Unknown error') });
  }
});

export default router;
