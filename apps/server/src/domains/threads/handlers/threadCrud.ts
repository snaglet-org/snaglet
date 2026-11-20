import type { Router } from 'express';
import { transaction } from '@snaglet/db/db';
import { Agents } from '@snaglet/db/tables/agents';
import { Memories } from '@snaglet/db/tables/memories';
import { Messages } from '@snaglet/db/tables/messages';
import { Nodes } from '@snaglet/db/tables/nodes';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { Threads, type UpdateThreadInput } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { Users } from '@snaglet/db/tables/users';
import { wsService } from '@server/services/WebSocketService';
import { emitThreadCreate } from '@server/services/customHooks/threadCreateEvent';
import { asyncHandler } from '@server/middleware';
import { sendCreated, sendOk } from '@server/utils/http';
import { AppError, asNonEmptyString, generateId, getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import {
  emitTreeNodeCreated,
  emitTreeNodeDeleted,
  emitTreeNodeUpdated,
  snapshotFromThread,
} from '@server/realtime/surfaces/tree';
import {
  emitThreadCreated,
  emitThreadDeleted,
  emitThreadUpdated,
  snapshotFromThreadNode,
} from '@server/realtime/surfaces/threads';
import {
  emitConversationBudgetChangedEvent,
  emitDispatchModeChangedEvent,
  emitMaxWavesChangedEvent,
} from '@server/services/SocketService/threadEvents';
import { hooks } from '@server/services/HookService';
import { withThreadExecutionPurge } from '@server/services/ThreadExecutionPurgeService';

const FOLDER_PLACEMENT_KEYS = ['container_id', 'containerId'] as const;
const SORT_ORDER_KEYS = ['sort_order', 'sortOrder'] as const;

/**
 * Threads are not placed in the folder tree: a thread is scoped by
 * `project_id` (a project container id, or null for a flat thread) and
 * ordered by `sort_order` within that list. A body that still carries a
 * folder placement is refused up front so the caller learns the field that
 * replaced it. A new thread always starts at the top of its list, so a create
 * refuses a sort order too.
 */
function rejectPlacementFields(body: Record<string, unknown>, op: 'create' | 'update'): void {
  const keys =
    op === 'create' ? [...FOLDER_PLACEMENT_KEYS, ...SORT_ORDER_KEYS] : FOLDER_PLACEMENT_KEYS;
  const offending = keys.filter((key) => key in body);
  if (offending.length === 0) return;
  throw new AppError(
    op === 'create'
      ? `${offending.join(', ')} does not apply to a new thread: a thread is scoped by project_id (a project container id, or null for a flat thread) and starts at the top of that list; reorder it afterward with PATCH sort_order`
      : `${offending.join(', ')} does not apply to threads: a thread is scoped by project_id (a project container id, or null for a flat thread) and ordered by sort_order within that list`,
    ErrorCode.VALIDATION_ERROR,
    HTTP_STATUS.BAD_REQUEST
  );
}

/**
 * Read `sort_order` / `sortOrder`: the thread's slot in its (target)
 * project's list, 0 = top. Siblings at that slot or later shift down by one.
 */
function readSortOrder(body: Record<string, unknown>): number | undefined {
  const raw =
    'sort_order' in body ? body.sort_order : 'sortOrder' in body ? body.sortOrder : undefined;
  if (raw === undefined) return undefined;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw;
  throw new AppError(
    'sort_order must be a non-negative integer: the slot in the thread’s project list, 0 = top',
    ErrorCode.VALIDATION_ERROR,
    HTTP_STATUS.BAD_REQUEST
  );
}

/**
 * Read `project_id` / `projectId` from a body, distinguishing absent
 * (`undefined`), explicit null (flat) and a project container id. Key
 * presence decides: `null ?? undefined` would collapse "make it flat" into
 * "not supplied".
 */
function readProjectId(body: Record<string, unknown>): string | null | undefined {
  const raw =
    'project_id' in body ? body.project_id : 'projectId' in body ? body.projectId : undefined;
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  throw new AppError(
    'project_id must be a project container id, or null for a flat thread',
    ErrorCode.VALIDATION_ERROR,
    HTTP_STATUS.BAD_REQUEST
  );
}

export function registerThreadCrudRoutes(router: Router): void {
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const agentId = req.query.agentId as string | undefined;
      const threads = agentId
        ? await Threads.listByAgent(agentId)
        : await Threads.list({ limit: 100 });
      sendOk(res, threads);
    })
  );

  // Threads with an agent run in progress right now. Seeds client-side live
  // indicators (workspace tree glow dots) before `thread.run_*` workspace
  // events stream in. Must be registered before `/:id`.
  router.get(
    '/active-runs',
    asyncHandler(async (_req, res) => {
      const { activeRunTracker } = await import('@server/services/ActiveRunTracker');
      const threadIds = activeRunTracker
        .snapshot()
        .activeSessionsByThread.map(({ threadId }) => threadId);
      sendOk(res, { threadIds });
    })
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const thread = await Threads.findById(req.params.id);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      sendOk(res, thread);
    })
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      rejectPlacementFields(body, 'create');
      const title = typeof body.title === 'string' ? body.title : undefined;
      const agentId = typeof body.agentId === 'string' ? body.agentId : undefined;
      const userId = typeof body.userId === 'string' ? body.userId : undefined;
      // Omitted and null both mean a flat thread. The target is checked by
      // Threads.create (Projects.assertProjectContainer) inside its
      // transaction, so an unknown or non-project id is a clean 404/400 that
      // writes nothing.
      const projectId = readProjectId(body) ?? null;

      let agentName: string | null = null;
      if (agentId) {
        const agent = await Agents.findById(agentId);
        if (!agent) {
          throw new AppError('Agent not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
        }
        agentName = agent.name;
      }
      if (userId && !(await Users.findById(userId))) {
        throw new AppError('User not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }

      const id = generateId('thread');
      // The thread and its first participants commit together: a failed
      // participant write rolls the thread back instead of leaving an
      // orphan. Events below fire only once everything is committed.
      const thread = await transaction(async (tx) => {
        const created = await Threads.create(
          { id, title: title ?? agentName ?? 'New thread', projectId },
          tx
        );
        if (agentId) {
          await ThreadParticipants.addParticipant({ threadId: id, agentId }, tx);
        }
        if (userId) {
          await ThreadParticipants.addUserParticipant({ threadId: id, userId }, tx);
        }
        return created;
      });
      emitTreeNodeCreated(snapshotFromThread(thread));
      emitThreadCreated(snapshotFromThreadNode(thread));
      // After the participant writes above — the shared builder reads the
      // roster from the DB; createdBy comes from the ambient request actor.
      emitThreadCreate(thread.id);
      sendCreated(res, thread);
    })
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      rejectPlacementFields(body, 'update');
      const title = asNonEmptyString(body.title);
      // `max_agent_dispatches` ("Max per-agent dispatches") is inert: the
      // dispatch loop does not read it. It is still accepted and persisted
      // (not rejected) so an older caller or UI request doesn't 400.
      const rawDispatches = body.max_agent_dispatches;
      const maxAgentDispatches =
        rawDispatches === null
          ? null
          : typeof rawDispatches === 'number' &&
              Number.isInteger(rawDispatches) &&
              rawDispatches > 0
            ? rawDispatches
            : undefined;

      const projectId = readProjectId(body);
      const sortOrder = readSortOrder(body);

      // Thread budget / tool-access settings are typed columns. There is no
      // `config_json` passthrough (it would let a client write keys nothing
      // validates); unknown body keys are ignored.
      /**
       * Read a settings field that distinguishes three cases: absent (leave
       * alone), explicit null (clear the override), and a value.
       *
       * `??` cannot be used to pick between the snake_case and camelCase
       * spellings here: `null ?? undefined` is `undefined`, so an explicit
       * "clear me" would arrive looking exactly like "not supplied" and get
       * rejected by the required-field guard below. Key presence is the only
       * thing that separates them — same reason `project_id` uses `in`.
       */
      const readField = (snake: string, camel: string): unknown =>
        snake in body ? body[snake] : camel in body ? body[camel] : undefined;

      const asOptionalInt = (raw: unknown, min: number): number | null | undefined => {
        if (raw === undefined) return undefined;
        if (raw === null) return null;
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min) {
          throw new AppError(
            `expected an integer >= ${min}, or null to clear`,
            ErrorCode.VALIDATION_ERROR,
            HTTP_STATUS.BAD_REQUEST
          );
        }
        return raw;
      };
      // maxWaves accepts null (clear), -1 (unbounded) or a positive cap, and
      // nothing else — 0 and -2 are outside threads_max_waves_check. Validated
      // here so a bad value is a 400, not an unhandled constraint violation.
      const rawMaxWaves = readField('max_waves', 'maxWaves');
      const maxWaves = asOptionalInt(rawMaxWaves, -1);
      if (typeof maxWaves === 'number' && maxWaves !== -1 && maxWaves <= 0) {
        throw new AppError(
          'max_waves must be a positive integer, -1 for unbounded, or null to clear',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      const maxTotalOutputTokens = asOptionalInt(
        readField('max_total_output_tokens', 'maxTotalOutputTokens'),
        1
      );
      const rawSystemPrompt = readField('thread_system_prompt', 'threadSystemPrompt');
      const threadSystemPrompt: string | null | undefined =
        rawSystemPrompt === undefined
          ? undefined
          : typeof rawSystemPrompt === 'string' && rawSystemPrompt.trim().length > 0
            ? rawSystemPrompt
            : null;

      const rawDispatchMode = body.dispatch_mode ?? body.dispatchMode;
      const dispatchMode: 'all' | 'mentioned' | undefined =
        rawDispatchMode === 'all' || rawDispatchMode === 'mentioned' ? rawDispatchMode : undefined;
      if (rawDispatchMode !== undefined && dispatchMode === undefined) {
        throw new AppError(
          `dispatch_mode must be one of: all, mentioned`,
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }

      if (
        !title &&
        projectId === undefined &&
        sortOrder === undefined &&
        maxAgentDispatches === undefined &&
        maxWaves === undefined &&
        maxTotalOutputTokens === undefined &&
        threadSystemPrompt === undefined &&
        dispatchMode === undefined
      ) {
        throw new AppError(
          'title, project_id, sort_order, max_agent_dispatches, max_waves, max_total_output_tokens, thread_system_prompt, or dispatch_mode is required',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }

      // Capture the prior values of every NARRATED setting so we only emit on a
      // REAL change — a no-op PATCH should not write a thread_event. One read
      // covers all three; emitted after a successful update in whichever branch
      // runs below. `max_agent_dispatches` is deliberately not narrated: the
      // dispatch loop does not read it (see the note above), so an event for
      // it would tell agents about a knob that does nothing. The same read
      // supplies the project the thread is leaving, so a move to the project it
      // is already in is a no-op that emits nothing.
      let priorDispatchMode: 'all' | 'mentioned' | null = null;
      let priorMaxWaves: number | null = null;
      let priorMaxTotalOutputTokens: number | null = null;
      let fromProjectId: string | null | undefined;
      if (
        projectId !== undefined ||
        dispatchMode !== undefined ||
        maxWaves !== undefined ||
        maxTotalOutputTokens !== undefined
      ) {
        const prior = await Threads.findById(req.params.id);
        // A DM / home thread holds the user and one agent, so routing never
        // applies; a change would only narrate a mode into its history.
        if (dispatchMode !== undefined && prior?.kind === 'dm') {
          throw new AppError(
            'dispatch_mode applies to group threads; a DM or home thread has no routing.',
            ErrorCode.VALIDATION_ERROR,
            HTTP_STATUS.BAD_REQUEST
          );
        }
        if (projectId !== undefined) {
          if (!prior) {
            throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
          }
          if (prior.projectId !== projectId) fromProjectId = prior.projectId;
        }
        priorDispatchMode = prior?.dispatchMode ?? null;
        priorMaxWaves = prior?.maxWaves ?? null;
        priorMaxTotalOutputTokens = prior?.maxTotalOutputTokens ?? null;
      }
      /**
       * Fire a narration without letting it touch the response. `void` alone is
       * not enough: it swallows neither a synchronous throw (which would 500 an
       * otherwise-successful PATCH) nor a rejection (an unhandled rejection).
       * The emitters absorb their own failures today; this keeps that true even
       * if one day they stop.
       */
      const narrate = (emit: () => Promise<void>): void => {
        try {
          void emit().catch((err: unknown) => {
            logger.warn(`[threads] settings narration failed: ${getErrorMessage(err)}`);
          });
        } catch (err) {
          logger.warn(`[threads] settings narration failed: ${getErrorMessage(err)}`);
        }
      };
      const narrateSettingChanges = (): void => {
        if (dispatchMode !== undefined && dispatchMode !== priorDispatchMode) {
          narrate(() => emitDispatchModeChangedEvent(req.params.id, dispatchMode));
        }
        if (maxWaves !== undefined && maxWaves !== priorMaxWaves) {
          narrate(() => emitMaxWavesChangedEvent(req.params.id, priorMaxWaves, maxWaves));
        }
        if (
          maxTotalOutputTokens !== undefined &&
          maxTotalOutputTokens !== priorMaxTotalOutputTokens
        ) {
          narrate(() =>
            emitConversationBudgetChangedEvent(
              req.params.id,
              priorMaxTotalOutputTokens,
              maxTotalOutputTokens
            )
          );
        }
      };

      const input: UpdateThreadInput = {};
      if (title) input.title = title;
      // The model's moveTo validates the target (404 unknown, 400 for a
      // non-project or archived project, 400 for an archived thread), shifts
      // the siblings at or after the slot and records the placement event. A
      // project change without sort_order lands at the top of that list.
      if (fromProjectId !== undefined) input.projectId = projectId;
      if (sortOrder !== undefined) input.sortOrder = sortOrder;
      if (maxAgentDispatches !== undefined) input.maxAgentDispatches = maxAgentDispatches;
      if (maxWaves !== undefined) input.maxWaves = maxWaves;
      if (maxTotalOutputTokens !== undefined) input.maxTotalOutputTokens = maxTotalOutputTokens;
      if (threadSystemPrompt !== undefined) input.threadSystemPrompt = threadSystemPrompt;
      if (dispatchMode !== undefined) input.dispatchMode = dispatchMode;

      const updated = await Threads.updateSettings(req.params.id, input);
      if (!updated) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      const moved = fromProjectId !== undefined;
      const placed = moved || sortOrder !== undefined;
      const updatedAt = updated.updatedAt ?? updated.createdAt;
      if (fromProjectId !== undefined) {
        hooks.emit('thread:move', {
          id: updated.id,
          fromProjectId,
          toProjectId: updated.projectId,
          fromContainerId: fromProjectId,
          toContainerId: updated.projectId,
        });
      }
      if (title || placed) {
        // A project move is a tree re-parent: the thread's parent on the tree
        // surface is its project (null = the flat list at the root). A move or
        // reorder carries the new slot as `sortKey`, which makes other clients
        // reload the tree (its siblings shifted too).
        emitTreeNodeUpdated({
          id: updated.id,
          kind: 'thread',
          ...(title ? { title: updated.title ?? '' } : {}),
          ...(moved ? { parentId: updated.projectId } : {}),
          ...(placed ? { sortKey: String(updated.sortOrder) } : {}),
          updatedAt,
        });
      }
      // A pure reorder changes nothing the thread surface carries.
      if (Object.keys(input).some((key) => key !== 'sortOrder')) {
        emitThreadUpdated({
          id: updated.id,
          ...(title ? { title: updated.title ?? '' } : {}),
          ...(moved ? { projectId: updated.projectId } : {}),
          updatedAt,
        });
      }
      narrateSettingChanges();
      sendOk(res, updated);
    })
  );

  // Clear a thread: hard-delete its messages (and their embeddings/links via
  // the nodes cascade) plus its runs and their activity log (tool calls,
  // thinking), keeping the thread itself. Turn replay rebuilds agent context
  // from messages + runs + activity — leaving any of the three behind
  // resurrects "cleared" content into the next prompt. The cost is that this
  // thread's token/usage history goes with it. Optionally also clears the
  // thread's summaries and/or the memories agents formed from it.
  router.post(
    '/:id/clear',
    asyncHandler(async (req, res) => {
      const thread = await Threads.findById(req.params.id);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }

      const clearSummaries = req.query.clearSummaries === 'true';
      const clearMemories = req.query.clearMemories === 'true';

      const purged = await withThreadExecutionPurge(
        [req.params.id],
        async ({ tx }) => {
          const deletedMessages = await Messages.deleteByThread(req.params.id, tx);
          // The last-message trigger is INSERT-only, so reset the watermark by hand.
          await Threads.resetLastMessageAt(req.params.id, tx);
          if (clearSummaries) await ThreadSummaries.deleteByThread(req.params.id, tx);
          if (clearMemories) await Memories.deleteByThread(req.params.id, tx);
          return { deletedMessages };
        },
        { keepsThreads: true }
      );
      const { deletedMessages } = purged.value;

      // Empty the message list for anyone viewing this thread (compact uses the
      // same per-thread channel).
      wsService.broadcastToChannel(req.params.id, {
        type: 'socket:thread:cleared',
        payload: { threadId: req.params.id, deletedMessages },
      });

      sendOk(res, {
        deletedMessages,
        deletedRuns: purged.deletedRuns,
        deletedActivity: purged.deletedActivity,
        clearedSummaries: clearSummaries,
        clearedMemories: clearMemories,
      });
    })
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const thread = await Threads.findById(req.params.id);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }

      const deleteMemories = req.query.deleteMemories === 'true';
      await withThreadExecutionPurge([req.params.id], async ({ tx }) => {
        if (deleteMemories) {
          await Memories.deleteByThread(req.params.id, tx);
        }
        await Nodes.deleteOfType(req.params.id, 'thread', tx);
      });
      emitTreeNodeDeleted(req.params.id, 'thread');
      emitThreadDeleted(req.params.id);
      sendOk(res, null);
    })
  );
}
