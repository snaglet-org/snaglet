/**
 * Threads & Messages API routes.
 *
 * Route bodies live in grouped handler modules so this file stays as the
 * route-surface wiring point for `/api/threads`.
 */

import { Router } from 'express';
import { registerDmRoutes } from './handlers/dmHandlers';
import { registerMessageRoutes } from './handlers/messageHandlers';
import { registerThreadNotificationSettingsRoutes } from './handlers/threadNotificationSettings';
import { registerParticipantRoutes } from './handlers/participantHandlers';
import { registerSubagentRoutes } from './handlers/subagentHandlers';
import { registerSummaryRoutes } from './handlers/summaryHandlers';
import { registerThreadCrudRoutes } from './handlers/threadCrud';
import { registerForkRoutes } from './handlers/forkHandlers';
import { registerTrimRoutes } from './handlers/trimHandlers';

import { registerThreadWorkingDirectoryRoutes } from './handlers/threadWorkingDirectory';

const router = Router();
registerThreadWorkingDirectoryRoutes(router);
// Before the `/:id` routes, or "dm" is parsed as a thread id.
registerDmRoutes(router);

registerThreadNotificationSettingsRoutes(router);
registerThreadCrudRoutes(router);
registerForkRoutes(router);
registerMessageRoutes(router);
registerSummaryRoutes(router);
registerParticipantRoutes(router);
registerTrimRoutes(router);
registerSubagentRoutes(router);

export default router;
