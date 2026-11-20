import type { Router } from 'express';
import { z } from 'zod';
import { Agents } from '@snaglet/db/tables/agents';
import { Members } from '@snaglet/db/tables/members';
import { Threads } from '@snaglet/db/tables/threads';
import { Users } from '@snaglet/db/tables/users';
import { asyncHandler } from '@server/middleware';
import { validateBody } from '@server/middleware/validation';
import { sendOk } from '@server/utils/http';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { DmService } from '@server/services/dm/DmService';

const OpenDmSchema = z.object({ agentId: z.string().min(1) }).strict();

function notFound(message: string): AppError {
  return new AppError(message, ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
}

/** The local user the UI acts as. */
async function localUserId(): Promise<string> {
  const active = await Users.getActiveUser().catch(() => null);
  return active?.id ?? (await Users.getOrCreateLocalUser()).id;
}

/**
 * Direct-message routes. Register before the `/:id` routes, or "dm" is read
 * as a thread id. A user-to-agent DM is sent and answered through the normal
 * chat socket path; there is deliberately no send route.
 */
export function registerDmRoutes(router: Router): void {
  router.get(
    '/dm',
    asyncHandler(async (req, res) => {
      const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : '';
      let member;
      if (agentId) {
        if (!(await Agents.findById(agentId))) throw notFound(`Agent not found: ${agentId}`);
        member = await Members.findByAgent(agentId);
      } else {
        member = await Members.findByUser(await localUserId());
      }
      const threads = member ? await DmService.listThreadsForMember(member.id) : [];
      sendOk(res, { threads });
    })
  );

  router.post(
    '/dm',
    validateBody(OpenDmSchema),
    asyncHandler(async (req, res) => {
      const { agentId } = req.body as z.infer<typeof OpenDmSchema>;
      const userId = await localUserId();
      const thread = await DmService.findOrCreate(
        { kind: 'user', userId },
        { kind: 'agent', agentId }
      );
      sendOk(res, { thread });
    })
  );

  router.post(
    '/:id/dm-read',
    asyncHandler(async (req, res) => {
      const thread = await Threads.findById(req.params.id);
      if (!thread || thread.kind !== 'dm') throw notFound('DM thread not found');
      const member = await Members.findByUser(await localUserId());
      if (member) await DmService.markRead(thread.id, member.id);
      sendOk(res, null);
    })
  );
}
