import { getErrorMessage, readTrimmedString } from '@snaglet/shared/utils';
import type { SubagentRow } from '@snaglet/db/tables/subagents';
import {
  SUBAGENT_WAIT_MAX_MS,
  SubagentError,
  subagentService,
} from '@server/services/subagents/SubagentService';
import { describeHelperModels } from '@server/services/subagents/helperModels';
import { resolveResumeAt } from '@server/services/subagents/pauseTime';
import { describeResumeTime } from '@server/services/subagents/subagentText';
import type { ToolHandler, ToolHandlerContext } from '@server/services/ToolService/types';

function requireCaller(context: ToolHandlerContext | undefined): {
  agentId: string;
  threadId: string;
} {
  if (!context?.agentId || !context.threadId) {
    throw new Error('subagent needs a calling agent in a thread.');
  }
  return { agentId: context.agentId, threadId: context.threadId };
}

function stateOf(sub: SubagentRow): string {
  if (sub.status !== 'stopped') return sub.status;
  return sub.resumeAt ? `paused until ${describeResumeTime(sub.resumeAt)}` : 'paused';
}

function line(sub: SubagentRow): string {
  const tasks = sub.taskCount === 1 ? '1 task' : `${sub.taskCount} tasks`;
  const error = sub.error ? ` (${sub.error})` : '';
  return `- ${sub.name} · ${sub.modelId} · ${stateOf(sub)}${error} · ${tasks} · id ${sub.id}`;
}

/** stop and pause: stop its run and keep it; pause may also set when it resumes on its own. */
const pauseOp: ToolHandler = async (input, _settings, context) => {
  const caller = requireCaller(context);
  const resumeAt = resolveResumeAt({ for: input.for, until: input.until });
  const { sub, interrupted, done } = await subagentService.pause({
    parentThreadId: caller.threadId,
    ref: readTrimmedString(input.name) ?? '',
    by: { kind: 'orchestrator', agentId: caller.agentId },
    resumeAt,
  });
  if (!done) {
    return `${sub.name}'s run is still stopping; it is paused as soon as that run ends.`;
  }
  const what = interrupted ? `Paused ${sub.name} (its run was stopped)` : `Paused ${sub.name}`;
  if (resumeAt) {
    return (
      `${what} until ${describeResumeTime(resumeAt.toISOString())}; then it resumes on its own where it left off. ` +
      `op:send with name "${sub.name}" before then resumes or redirects it at once and cancels the timer.`
    );
  }
  return (
    `${what}. It keeps its thread, brief and work so far and does nothing until you call ` +
    `op:send with name "${sub.name}" to resume or redirect it; it is removed after a day without work.`
  );
};

function readInstructions(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new SubagentError('instructions must be a string.');
  return raw;
}

function readTools(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.some((t) => typeof t !== 'string')) {
    throw new SubagentError('tools must be an array of tool ids.');
  }
  return raw as string[];
}

const OPS: Record<string, ToolHandler> = {
  start: async (input, _settings, context) => {
    const caller = requireCaller(context);
    const sub = await subagentService.start({
      orchestratorAgentId: caller.agentId,
      parentThreadId: caller.threadId,
      name: readTrimmedString(input.name) ?? '',
      model: readTrimmedString(input.model) ?? '',
      brief: typeof input.brief === 'string' ? input.brief : '',
      tools: readTools(input.tools),
      instructions: readInstructions(input.instructions),
    });
    return {
      output:
        `Started subagent ${sub.name} on ${sub.modelId} (id ${sub.id}). ` +
        'Never write or guess its report. To use it in this turn, call subagent op:wait; ' +
        'otherwise end your turn and Snaglet delivers the report as a separate message that wakes you.',
      rawContent: {
        subagent_id: sub.id,
        name: sub.name,
        model: sub.modelId,
        thread_id: sub.threadId,
      },
    };
  },
  send: async (input, _settings, context) => {
    const caller = requireCaller(context);
    const sub = await subagentService.send({
      orchestratorAgentId: caller.agentId,
      parentThreadId: caller.threadId,
      ref: readTrimmedString(input.name) ?? '',
      message: typeof input.message === 'string' ? input.message : '',
    });
    return `Sent to ${sub.name}. Its next report arrives the same way.`;
  },
  wait: async (input, _settings, context) => {
    const caller = requireCaller(context);
    const seconds = typeof input.timeout_seconds === 'number' ? input.timeout_seconds : 240;
    const timeoutMs = Math.max(1, Math.min(SUBAGENT_WAIT_MAX_MS / 1000, seconds)) * 1000;
    const names = Array.isArray(input.names)
      ? input.names.filter((n): n is string => typeof n === 'string')
      : readTrimmedString(input.name)
        ? [readTrimmedString(input.name)!]
        : null;
    const { reports, stillRunning } = await subagentService.wait({
      orchestratorAgentId: caller.agentId,
      parentThreadId: caller.threadId,
      names,
      timeoutMs,
      signal: context?.signal,
    });
    if (reports.length === 0 && stillRunning.length === 0) {
      return 'No subagent reports are pending for you in this thread.';
    }
    const parts = reports.map((r) => r.content);
    if (stillRunning.length > 0) {
      parts.push(
        `Still running: ${stillRunning.map((s) => s.name).join(', ')}. ` +
          'Call wait again, or end your turn: their reports wake you.'
      );
    }
    return parts.join('\n\n');
  },
  stop: pauseOp,
  pause: pauseOp,
  update: async (input, _settings, context) => {
    const caller = requireCaller(context);
    if (input.instructions === undefined) {
      throw new SubagentError('update needs instructions (an empty string clears them).');
    }
    const { sub, instructions } = await subagentService.updateInstructions({
      parentThreadId: caller.threadId,
      ref: readTrimmedString(input.name) ?? '',
      by: { kind: 'orchestrator', agentId: caller.agentId },
      instructions: readInstructions(input.instructions),
    });
    return instructions
      ? `Updated ${sub.name}'s instructions; they apply from its next turn (a run already going keeps the old ones).`
      : `Cleared ${sub.name}'s instructions; this applies from its next turn.`;
  },
  remove: async (input, _settings, context) => {
    const caller = requireCaller(context);
    const { sub, removed } = await subagentService.remove({
      parentThreadId: caller.threadId,
      ref: readTrimmedString(input.name) ?? '',
      by: { kind: 'orchestrator', agentId: caller.agentId },
    });
    return removed
      ? `Removed ${sub.name}: its thread and work are deleted.`
      : `${sub.name}'s run is still stopping; it is removed as soon as that run ends.`;
  },
  list: async (_input, _settings, context) => {
    const caller = requireCaller(context);
    const live = await subagentService.list(caller.threadId);
    const mine = live.filter((s) => s.orchestratorAgentId === caller.agentId);
    if (mine.length === 0) return 'No live subagents in this thread.';
    return mine.map(line).join('\n');
  },
  models: async (_input, _settings, context) => {
    const caller = requireCaller(context);
    return describeHelperModels(caller.threadId, caller.agentId);
  },
};

/** subagent(op): start / send / wait / stop / pause / update / remove / list the calling agent's helpers; models lists what they can run on. */
const tool: ToolHandler = async (input, settings, context) => {
  const op = typeof input.op === 'string' ? input.op : undefined;
  const handler = op ? OPS[op] : undefined;
  if (!handler)
    throw new Error(`op is required and must be one of ${Object.keys(OPS).join(' | ')}.`);
  try {
    return await handler(input, settings, context);
  } catch (err) {
    // Validation problems read as plain instructions to the model.
    if (err instanceof SubagentError) throw new Error(`subagent ${op}: ${getErrorMessage(err)}`);
    throw err;
  }
};

export default tool;
