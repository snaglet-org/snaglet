/**
 * runs.ts — read-only surface over the `runs` table.
 *
 * Backs the sidebar "Runs" dropdown: each row is an agent name + run id the
 * user can drag as a chip. Read-only on purpose — runs are execution history
 * written by the dispatch pipeline, never edited from the UI.
 *
 * Auth: mounted under `/api`, so `sidecarAuthMiddleware` already guards it
 * (401 without the session token when `SNAGLET_AUTH_TOKEN` is set). No extra
 * `panelAuthMiddleware` — that gates mutations, and this router has none.
 */
import { Router } from 'express';
import { Runs } from '@snaglet/db';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';

const router = Router();

/** Hard ceiling so a hand-crafted `?limit=` can't ask for the whole table. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * GET /api/runs?threadId=…&limit=…&agentId=…
 *
 * Returns recent runs for a thread, newest first:
 * `{ id, agentId, agentName, status, startedAt, finishedAt }`.
 *
 * `threadId` is required — the dropdown is always thread-scoped, and an
 * unscoped "all runs everywhere" query has no caller and would scan the
 * whole history table.
 *
 * `agentId` is optional and narrows to one agent's runs. The sidebar always
 * passes it: each agent row wants its own newest-N, and filtering client-side
 * would let a chatty agent fill the limit window and hide a quieter agent's
 * runs entirely.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : '';
    if (!threadId) {
      res.status(400).json({ ok: false, error: 'threadId is required' });
      return;
    }

    // `Number('')` is 0 and `Number(undefined)` is NaN — both fall back to the
    // default rather than being treated as "limit 0" (which would return
    // nothing and look like an empty thread).
    const requested = Number(req.query.limit);
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_LIMIT)
        : DEFAULT_LIMIT;

    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';

    sendOk(res, await Runs.listRecentByThread(threadId, limit, agentId || null));
  })
);

export default router;
