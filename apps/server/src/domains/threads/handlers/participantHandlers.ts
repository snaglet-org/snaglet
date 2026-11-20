import type { Router } from 'express';
import { participantAgentId } from './participantAgentId';
import { participantCallingAgent } from './participantCaller';
import { assertHelperParticipantEdit } from '../helperParticipantPolicy';
import { removeAgentParticipant } from '../removeAgentParticipant';
import { z } from 'zod';
import { Agents } from '@snaglet/db/tables/agents';
import { Users } from '@snaglet/db/tables/users';
import { Threads } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { asyncHandler } from '@server/middleware';
import { validateBody } from '@server/middleware/validation';
import { sendCreated, sendOk } from '@server/utils/http';
import { AppError, ConflictError, asNonEmptyString } from '@snaglet/shared/utils';
import { SkillAssignmentService } from '@server/services/skills/SkillAssignmentService';
import { syncHelperModel } from '@server/services/subagents/helperModelSync';
import { markThreadRosterChanged } from '@server/services/SocketService/dispatch/rosterVersion';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import {
  emitModelChangedEvent,
  emitParticipantAddedEvent,
  emitRunTimeLimitChangedEvent,
  type ThreadEventModelIdentity,
} from '@server/services/SocketService/threadEvents';

const AddParticipantSchema = z
  .object({
    agentId: z.string().optional(),
    userId: z.string().min(1).optional(),
    role: z.string().optional(),
    credentialId: z.string().nullable().optional(),
    modelId: z.string().nullable().optional(),
  })
  .strict();

const UpdateModelSchema = z
  .object({
    credentialId: z.string().nullable().optional(),
    modelId: z.string().nullable().optional(),
    providerId: z.string().nullable().optional(),
    disableFallback: z.boolean().optional(),
  })
  .strict();

const ToolAccessModeSchema = z.enum(['all', 'allow_list', 'deny_list']);

const UpdateSkillsSchema = z
  .object({
    mode: z.enum(['inherit', 'add', 'override']).optional(),
    skillIds: z.array(z.string().min(1)).max(200).optional(),
  })
  .strict()
  .refine((b) => b.mode !== undefined || b.skillIds !== undefined, {
    message: 'Provide mode and/or skillIds',
  });

const UpdateOverridesSchema = z
  .object({
    systemPromptAddendum: z.string().nullable().optional(),
    expectedSystemPromptAddendum: z.string().nullable().optional(),
    toolAccessMode: ToolAccessModeSchema.nullable().optional(),
    toolAccessAllowList: z.array(z.string()).nullable().optional(),
    toolAccessDenyList: z.array(z.string()).nullable().optional(),
    toolOverrides: z.record(z.unknown()).nullable().optional(),
    maxToolCallsPerTurn: z.number().int().positive().nullable().optional(),
    maxDurationSeconds: z.number().int().positive().nullable().optional(),
    autoRespond: z.boolean().optional(),
  })
  .strict();

function declaredUserId(req: { headers: Record<string, unknown> }): string | null {
  const raw = req.headers['x-snaglet-actor-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

function effectiveModelChanged(
  previousModel: ThreadEventModelIdentity | null | undefined,
  nextModel: ThreadEventModelIdentity | null | undefined
): boolean {
  return (
    previousModel?.providerId !== nextModel?.providerId ||
    previousModel?.modelId !== nextModel?.modelId
  );
}

async function narrateModelChange(
  threadId: string,
  agentId: string,
  previousModel: ThreadEventModelIdentity | null | undefined
): Promise<void> {
  try {
    const nextModel = await Threads.getEffectiveModel(threadId, agentId);
    if (!effectiveModelChanged(previousModel, nextModel)) return;
    await emitModelChangedEvent(threadId, agentId, previousModel ?? null, nextModel);
  } catch {
    // Thread-event narration is best-effort and must not alter route behavior.
  }
}

async function narrateRunTimeLimitChange(
  threadId: string,
  agentId: string,
  previousSeconds: number | null,
  nextSeconds: number | null
): Promise<void> {
  if (previousSeconds === nextSeconds) return;
  try {
    await emitRunTimeLimitChangedEvent(threadId, agentId, previousSeconds, nextSeconds);
  } catch {
    // Thread-event narration is best-effort and must not alter route behavior.
  }
}

export function registerParticipantRoutes(router: Router): void {
  router.get(
    '/:id/participants',
    asyncHandler(async (req, res) => {
      const thread = await Threads.findById(req.params.id);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      const participants = await ThreadParticipants.listByThread(req.params.id);
      sendOk(res, participants);
    })
  );

  router.post(
    '/:id/participants',
    validateBody(AddParticipantSchema),
    asyncHandler(async (req, res) => {
      const thread = await Threads.findById(req.params.id);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      // A DM is between exactly its two parties; nobody joins one.
      if (thread.kind === 'dm') {
        throw new ConflictError(
          "Participants can't be added to a DM conversation: a DM is between exactly two parties."
        );
      }
      if (thread.parentThreadId) {
        await assertHelperParticipantEdit(thread, await participantCallingAgent(req));
      }
      // A helper's hidden thread belongs to that helper alone.
      if (thread.parentThreadId) {
        throw new AppError(
          "Participants can't be added to a subagent's thread.",
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }

      const { agentId, userId, credentialId, modelId } = req.body as {
        agentId?: string;
        userId?: string;
        credentialId?: string | null;
        modelId?: string | null;
      };

      if ((agentId ? 1 : 0) + (userId ? 1 : 0) !== 1) {
        throw new AppError(
          'Exactly one of agentId or userId is required',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }

      if (agentId) {
        const agent = await Agents.findById(agentId);
        if (!agent) {
          throw new AppError('Agent not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
        }
      } else {
        const user = await Users.findById(userId!);
        if (!user) {
          throw new AppError('User not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
        }
      }

      const participant = agentId
        ? await ThreadParticipants.addParticipant({
            threadId: req.params.id,
            agentId,
            credentialId,
            modelId,
          })
        : await ThreadParticipants.addUserParticipant({ threadId: req.params.id, userId: userId! });

      // Narrate the roster change as an append-only thread_event —
      // only for agent joins (agents are the participants that reason over the
      // roster). Best-effort; never fails the request.
      if (agentId) {
        void emitParticipantAddedEvent(req.params.id, agentId);
        // A run going on in this thread can now @-mention them.
        markThreadRosterChanged(req.params.id);
      }

      sendCreated(res, participant);
    })
  );

  router.delete(
    '/:id/participants/:agentId',
    asyncHandler(async (req, res) => {
      const thread = await Threads.findById(req.params.id);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      // A DM keeps both its parties: one left alone would still hold the
      // pair's thread, which then neither lists nor reads for the other.
      if (thread.kind === 'dm') {
        throw new ConflictError(
          "Participants can't be removed from a DM conversation: a DM is between exactly two parties. Delete the conversation instead."
        );
      }
      if (thread.parentThreadId) {
        await assertHelperParticipantEdit(thread, await participantCallingAgent(req));
      }

      // Participant removal is open to any actor — there is no role-based
      // permission gate. The actor identity is still captured (when supplied)
      // purely for the activity-log entry.
      const actorFromQuery = asNonEmptyString(req.query.actorAgentId);
      const actorFromBody = asNonEmptyString(
        (req.body as { actorAgentId?: string } | undefined)?.actorAgentId
      );

      // The same removal the thread tool's leave / remove_agents use.
      const removed = await removeAgentParticipant({
        threadId: thread.id,
        agentId: req.params.agentId,
        actorAgentId: actorFromQuery ?? actorFromBody ?? null,
        actorUserId: declaredUserId(req),
      });
      if (!removed) {
        throw new AppError(
          'Thread participant not found',
          ErrorCode.NOT_FOUND,
          HTTP_STATUS.NOT_FOUND
        );
      }

      sendOk(res, null);
    })
  );

  router.patch(
    '/:id/participants/:agentId/model',
    validateBody(UpdateModelSchema),
    asyncHandler(async (req, res) => {
      const thread = await Threads.findById(req.params.id);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      if (thread.parentThreadId) {
        await assertHelperParticipantEdit(thread, await participantCallingAgent(req));
      }

      const { credentialId, modelId, providerId, disableFallback } = req.body as {
        credentialId?: string | null;
        modelId?: string | null;
        providerId?: string | null;
        disableFallback?: boolean;
      };

      // Capture the effective provider/model before mutating the participant.
      // A failed narration lookup must not turn an otherwise-valid PATCH into
      // an error, so undefined also acts as the "do not narrate" sentinel.
      let previousModel: ThreadEventModelIdentity | null | undefined;
      try {
        previousModel = await Threads.getEffectiveModel(req.params.id, req.params.agentId);
      } catch {
        previousModel = undefined;
      }

      const updated = await ThreadParticipants.updateModel(req.params.id, req.params.agentId, {
        credentialId,
        modelId,
        providerId,
        ...(disableFallback !== undefined ? { disableModelFallback: disableFallback } : {}),
      });

      if (!updated) {
        throw new AppError(
          'Thread participant not found',
          ErrorCode.NOT_FOUND,
          HTTP_STATUS.NOT_FOUND
        );
      }

      if (previousModel !== undefined) {
        // Persist before acknowledging the PATCH so an immediately-following
        // turn cannot build context ahead of its model-change narration. The
        // helper absorbs narration failures, and the event never dispatches a
        // wave; future turns receive it through ordinary replay.
        await narrateModelChange(req.params.id, req.params.agentId, previousModel);
      }
      if (thread.parentThreadId) await syncHelperModel(req.params.id, req.params.agentId);

      sendOk(res, updated);
    })
  );

  // Skills: this agent's skill mode + thread picks, and the resolved set.
  router.get(
    '/:id/participants/:agentId/skills',
    asyncHandler(async (req, res) => {
      sendOk(res, await SkillAssignmentService.getThreadState(req.params.id, req.params.agentId));
    })
  );

  router.put(
    '/:id/participants/:agentId/skills',
    validateBody(UpdateSkillsSchema),
    asyncHandler(async (req, res) => {
      const thread = await Threads.findById(req.params.id);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      if (thread.parentThreadId) {
        await assertHelperParticipantEdit(thread, await participantCallingAgent(req));
      }
      const body = req.body as z.infer<typeof UpdateSkillsSchema>;
      sendOk(
        res,
        await SkillAssignmentService.updateThread(req.params.id, req.params.agentId, body)
      );
    })
  );

  router.patch(
    '/:id/participants/:agentId/overrides',
    validateBody(UpdateOverridesSchema),
    asyncHandler(async (req, res) => {
      const thread = await Threads.findById(req.params.id);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      if (thread.parentThreadId) {
        await assertHelperParticipantEdit(thread, await participantCallingAgent(req));
      }

      const body = req.body as {
        systemPromptAddendum?: string | null;
        expectedSystemPromptAddendum?: string | null;
        toolAccessMode?: string | null;
        toolAccessAllowList?: string[] | null;
        toolAccessDenyList?: string[] | null;
        toolOverrides?: Record<string, unknown> | null;
        maxToolCallsPerTurn?: number | null;
        maxDurationSeconds?: number | null;
        autoRespond?: boolean;
      };

      // Capture the prior run time limit ("thread duration" in settings) before
      // mutating, so only a REAL change narrates. `undefined` doubles as the
      // "do not narrate" sentinel: a failed lookup must not turn an otherwise
      // valid PATCH into an error, and the field being absent from the body is
      // equally a reason to stay quiet.
      let priorMaxDurationSeconds: number | null | undefined;
      if (body.maxDurationSeconds !== undefined) {
        try {
          const participants = await ThreadParticipants.listByThread(req.params.id);
          const existing = participants.find(
            (candidate) => participantAgentId(candidate) === req.params.agentId
          );
          priorMaxDurationSeconds = existing?.maxDurationSeconds ?? null;
        } catch {
          priorMaxDurationSeconds = undefined;
        }
      }

      const updated = await ThreadParticipants.updateOverrides(req.params.id, req.params.agentId, {
        ...(body.expectedSystemPromptAddendum !== undefined
          ? { expectedSystemPromptAddendum: body.expectedSystemPromptAddendum }
          : {}),
        ...(body.systemPromptAddendum !== undefined
          ? { systemPromptAddendum: body.systemPromptAddendum }
          : {}),
        ...(body.toolAccessMode !== undefined ? { toolAccessMode: body.toolAccessMode } : {}),
        ...(body.toolAccessAllowList !== undefined
          ? { toolAccessAllowList: body.toolAccessAllowList }
          : {}),
        ...(body.toolAccessDenyList !== undefined
          ? { toolAccessDenyList: body.toolAccessDenyList }
          : {}),
        ...(body.toolOverrides !== undefined ? { toolOverrides: body.toolOverrides } : {}),
        ...(body.maxToolCallsPerTurn !== undefined
          ? { maxToolCallsPerTurn: body.maxToolCallsPerTurn }
          : {}),
        ...(body.maxDurationSeconds !== undefined
          ? { maxDurationSeconds: body.maxDurationSeconds }
          : {}),
        ...(body.autoRespond !== undefined ? { autoRespond: body.autoRespond } : {}),
      });

      if (!updated) {
        if (body.expectedSystemPromptAddendum !== undefined) {
          throw new AppError(
            'Instructions changed since Settings opened. Reopen Settings to review the current instructions before saving again.',
            ErrorCode.CONFLICT,
            HTTP_STATUS.CONFLICT
          );
        }
        throw new AppError(
          'Thread participant not found',
          ErrorCode.NOT_FOUND,
          HTTP_STATUS.NOT_FOUND
        );
      }

      if (priorMaxDurationSeconds !== undefined) {
        // Persist before acknowledging the PATCH so an immediately-following
        // turn cannot build context ahead of its narration. The helper absorbs
        // narration failures, so this can never fail the request.
        await narrateRunTimeLimitChange(
          req.params.id,
          req.params.agentId,
          priorMaxDurationSeconds,
          body.maxDurationSeconds ?? null
        );
      }

      sendOk(res, updated);
    })
  );
}
