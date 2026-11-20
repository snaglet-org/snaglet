/**
 * Automations routes — /api/automations (contract: packages/shared/types/automations.ts).
 *
 * Reads are open like the rest of /api; every write needs the panel token,
 * so these are people's routes (agents use the `automation` tool and its
 * agent rules). All writes go through AutomationService.
 */
import { Router } from 'express';
import {
  AUTOMATION_STATUSES,
  ErrorCode,
  HTTP_STATUS,
  type AutomationPauseResponse,
  type AutomationRecentRunsResponse,
  type AutomationResponse,
  type AutomationResumeResponse,
  type AutomationRunNowResponse,
  type AutomationRunsResponse,
  type AutomationStatus,
  type AutomationsResponse,
} from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import { asyncHandler } from '@server/middleware';
import { panelAuthMiddleware } from '@server/middleware/panelAuth';
import { sendCreated, sendOk } from '@server/utils/http';
import {
  automationService,
  type AutomationActor,
} from '@server/services/automations/AutomationService';

const router = Router();
const PERSON: AutomationActor = { kind: 'person' };

function statusFilter(value: unknown): AutomationStatus | 'all' {
  if (value === undefined || value === '' || value === 'all') return 'all';
  if (typeof value === 'string' && (AUTOMATION_STATUSES as readonly string[]).includes(value)) {
    return value as AutomationStatus;
  }
  throw new AppError(
    'status must be active, paused, finished, cancelled or all.',
    ErrorCode.VALIDATION_ERROR,
    HTTP_STATUS.BAD_REQUEST
  );
}

const RUNS_PAGE = 50;
const RECENT_RUNS = 20;
const RUNS_PAGE_MAX = 100;

function runsLimit(value: unknown): number {
  if (value === undefined || value === '') return RUNS_PAGE;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > RUNS_PAGE_MAX) {
    throw new AppError(
      `limit must be a whole number from 1 to ${RUNS_PAGE_MAX}.`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  return limit;
}

function body(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const automations = await automationService.list({ status: statusFilter(req.query.status) });
    sendOk<AutomationsResponse>(res, { automations });
  })
);

// The run log across automations (the Automations view's Recent runs). Above
// `/:id` so "runs" is never read as an automation id.
router.get(
  '/runs/recent',
  asyncHandler(async (req, res) => {
    const limit = req.query.limit === undefined ? RECENT_RUNS : runsLimit(req.query.limit);
    sendOk<AutomationRecentRunsResponse>(res, await automationService.recentRuns(limit));
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    sendOk<AutomationResponse>(res, { automation: await automationService.get(req.params.id) });
  })
);

router.get(
  '/:id/runs',
  asyncHandler(async (req, res) => {
    const before =
      typeof req.query.before === 'string' && req.query.before ? req.query.before : null;
    sendOk<AutomationRunsResponse>(
      res,
      await automationService.runs(req.params.id, { limit: runsLimit(req.query.limit), before })
    );
  })
);

router.post(
  '/',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    const input = body(req.body);
    const automation = await automationService.create(
      {
        name: input.name,
        prompt: input.prompt,
        when: input.when,
        calendarId: input.calendarId,
        threadId: input.threadId,
        agentId: input.agentId,
        ...(input.unattendedPolicy !== undefined
          ? { unattendedPolicy: input.unattendedPolicy }
          : {}),
      },
      PERSON
    );
    sendCreated<AutomationResponse>(res, { automation });
  })
);

router.patch(
  '/:id',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    const input = body(req.body);
    const automation = await automationService.update(
      req.params.id,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.when !== undefined ? { when: input.when } : {}),
        ...(input.calendarId !== undefined ? { calendarId: input.calendarId } : {}),
        ...(input.unattendedPolicy !== undefined
          ? { unattendedPolicy: input.unattendedPolicy }
          : {}),
      },
      PERSON
    );
    sendOk<AutomationResponse>(res, { automation });
  })
);

router.post(
  '/:id/pause',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    sendOk<AutomationPauseResponse>(
      res,
      await automationService.pauseWithUndo(req.params.id, PERSON)
    );
  })
);

/** Undo a pause with its `undoToken`: active again, with the failure streak it kept. */
router.post(
  '/:id/pause/undo',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    sendOk<AutomationResponse>(res, {
      automation: await automationService.undoPause(req.params.id, body(req.body).token, PERSON),
    });
  })
);

router.post(
  '/:id/resume',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    sendOk<AutomationResumeResponse>(
      res,
      await automationService.resumeWithUndo(req.params.id, PERSON)
    );
  })
);

/** Undo a resume with its `undoToken`: paused again, reason and failure streak too. */
router.post(
  '/:id/resume/undo',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    sendOk<AutomationResponse>(res, {
      automation: await automationService.undoResume(req.params.id, body(req.body).token, PERSON),
    });
  })
);

router.post(
  '/:id/run',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    sendOk<AutomationRunNowResponse>(res, await automationService.runNow(req.params.id, PERSON));
  })
);

router.delete(
  '/:id',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    sendOk<AutomationResponse>(res, {
      automation: await automationService.cancel(req.params.id, PERSON),
    });
  })
);

/** The Archive drawer's Restore: a deleted automation back as it was; any other unchanged. */
router.post(
  '/:id/restore',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    sendOk<AutomationResponse>(res, {
      automation: await automationService.restoreArchived(req.params.id, PERSON),
    });
  })
);

/** The Archive drawer's Delete: a deleted automation for good (409 for any other). */
router.delete(
  '/:id/purge',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    sendOk<AutomationResponse>(res, {
      automation: await automationService.purge(req.params.id, PERSON),
    });
  })
);

export default router;
