/**
 * Tools API routes (/api/tools): list and create, reload, execute (plus /log
 * and the /test sandbox), workspaces, per-agent assignments, and single-tool
 * get/update/enable/delete. This file is thin wiring; handlers live in
 * ./routes/*.routes.ts, grouped by resource. Mount order matters: the `/:id`
 * wildcard sub-router (single.routes) mounts last, otherwise `/agent` and
 * `/workspaces` would match as tool ids.
 */

import { Router } from 'express';
import collectionRoutes from './routes/collection.routes';
import executionRoutes from './routes/execution.routes';
import workspacesRoutes from './routes/workspaces.routes';
import assignmentsRoutes from './routes/assignments.routes';
import singleRoutes from './routes/single.routes';
import { panelAuthMiddleware, toolDispatchAuthMiddleware } from '@server/middleware/panelAuth';

const router = Router();

// Order-critical: specific paths before the `/:id` wildcard.
router.use(collectionRoutes);

// Execution routes (act_as impersonation, and arbitrary code via
// /execute/test) are mounted unless SNAGLET_DISABLE_TOOL_EXECUTION=true, which
// unmounts them so requests 404 (ToolView reads that 404 as "execution
// disabled in this build"). See panelAuth.ts for what the token check stops.
//
// Auth is path-scoped: `router.use(panelAuthMiddleware, routes)` would run for
// every /api/tools/* request and reject all of them on a missing token. Layers
// run in registration order, so '/execute/test' (panel auth only, never the
// child-dispatch credential) comes before '/execute', which also accepts the
// child-dispatch token and so only relaxes /execute and /execute/log.
if (process.env.SNAGLET_DISABLE_TOOL_EXECUTION !== 'true') {
  router.use('/execute/test', panelAuthMiddleware);
  router.use('/execute', toolDispatchAuthMiddleware);
  router.use(executionRoutes);
}
router.use(workspacesRoutes);
router.use(assignmentsRoutes);
router.use(singleRoutes); // `/:id` wildcard: must be last

export default router;
