import type { Request, Router } from 'express';
import { Agents } from '@snaglet/db/tables/agents';
import { Subagents, type SubagentRow } from '@snaglet/db/tables/subagents';
import { Threads } from '@snaglet/db/tables/threads';
import { Users } from '@snaglet/db/tables/users';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS, type SubagentSummary } from '@snaglet/shared/types';
import { asyncHandler } from '@server/middleware';
import { getCurrentActor } from '@server/realtime/actorContext';
import { toSubagentSummary } from '@server/realtime/surfaces/subagents';
import { resolveResumeAt } from '@server/services/subagents/pauseTime';
import {
  SubagentError,
  subagentService,
  type SubagentActor,
} from '@server/services/subagents/SubagentService';
import { sendOk } from '@server/utils/http';

async function summaryOf(row: SubagentRow | null): Promise<SubagentSummary | null> {
  if (!row || row.deletedAt) return null;
  const orchestrator = await Agents.findById(row.orchestratorAgentId);
  return toSubagentSummary(row, orchestrator?.name ?? null);
}

/** The person acting through the UI, named as the orchestrator's notice names them. */
async function requestUser(): Promise<SubagentActor> {
  const actor = getCurrentActor();
  if (actor?.actorKind === 'user') {
    return { kind: 'user', userId: actor.actorId, name: actor.actorName?.trim() || 'the user' };
  }
  const active = await Users.getActiveUser().catch(() => null);
  const user = active ?? (await Users.findById((await Users.getOrCreateLocalUser()).id));
  return { kind: 'user', userId: user?.id ?? 'local_user', name: user?.name?.trim() || 'the user' };
}

/** A live helper of the thread in the URL, by its id. */
async function liveHelperOf(req: Request): Promise<SubagentRow> {
  const sub = await Subagents.findById(req.params.subagentId ?? '');
  if (!sub || sub.deletedAt || sub.parentThreadId !== req.params.id) {
    throw new AppError('Subagent not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }
  return sub;
}

/** Service refusals ("is not paused", a bad pause length) are the caller's to fix. */
async function asRequest<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SubagentError) {
      throw new AppError(getErrorMessage(err), ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
    throw err;
  }
}

/**
 * Subagent helpers of a thread. The composer strip seeds from the list
 * and then follows `subagent:changed` frames on the thread's channel; its
 * chip menu and the helper thread's header pause, resume and remove one.
 */
export function registerSubagentRoutes(router: Router): void {
  router.get(
    '/:id/subagents',
    asyncHandler(async (req, res) => {
      const thread = await Threads.findById(req.params.id);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      const rows = await Subagents.listLiveForParent(thread.id);
      const orchestrators = await Agents.findByIds([
        ...new Set(rows.map((r) => r.orchestratorAgentId)),
      ]);
      const names = new Map(orchestrators.map((a) => [a.id, a.name]));
      const subagents: SubagentSummary[] = rows.map((row) =>
        toSubagentSummary(row, names.get(row.orchestratorAgentId) ?? null)
      );
      sendOk(res, { subagents });
    })
  );

  // Body: { for?: "15m" } or { until?: ISO } for a timed pause; neither = until resumed.
  router.post(
    '/:id/subagents/:subagentId/pause',
    asyncHandler(async (req, res) => {
      const sub = await liveHelperOf(req);
      const body = (req.body ?? {}) as { for?: unknown; until?: unknown };
      const result = await asRequest(async () =>
        subagentService.pause({
          parentThreadId: sub.parentThreadId,
          ref: sub.id,
          by: await requestUser(),
          resumeAt: resolveResumeAt({ for: body.for, until: body.until }),
        })
      );
      sendOk(res, { subagent: await summaryOf(result.sub), done: result.done });
    })
  );

  router.post(
    '/:id/subagents/:subagentId/resume',
    asyncHandler(async (req, res) => {
      const sub = await liveHelperOf(req);
      const resumed = await asRequest(async () =>
        subagentService.resume({
          parentThreadId: sub.parentThreadId,
          ref: sub.id,
          by: await requestUser(),
        })
      );
      sendOk(res, { subagent: await summaryOf(resumed) });
    })
  );

  router.delete(
    '/:id/subagents/:subagentId',
    asyncHandler(async (req, res) => {
      const sub = await liveHelperOf(req);
      const result = await asRequest(async () =>
        subagentService.remove({
          parentThreadId: sub.parentThreadId,
          ref: sub.id,
          by: await requestUser(),
        })
      );
      sendOk(res, { removed: result.removed });
    })
  );
}
