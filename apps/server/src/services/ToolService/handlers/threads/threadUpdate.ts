import { Containers } from '@snaglet/db/tables/containers';
import { Projects } from '@snaglet/db/tables/projects';
import { Threads, type UpdateThreadInput } from '@snaglet/db/tables/threads';
import { asNonEmptyString, getErrorMessage, isRecord } from '@snaglet/shared/utils';
import { getCurrentActor } from '@server/realtime/actorContext';
import { emitThreadUpdated } from '@server/realtime/surfaces/threads';
import { emitTreeNodeUpdated } from '@server/realtime/surfaces/tree';
import { hooks, type HookEventMap } from '@server/services/HookService';
import type { ToolHandler } from '@server/services/ToolService/types';
import { findProjectAncestor } from '@server/services/ToolService/lib/findProjectAncestor';
import { describeAgentCwd } from '@server/services/ToolService/lib/resolveAgentCwd';
import { validateThreadWorkingDirectory } from '@server/services/ToolService/lib/threadWorkingDirectory';
import {
  assertNotDmThread,
  resolveTargetThreadId,
  threadNotFoundError,
} from '@server/services/ToolService/lib/targetThread';

type UpdatedBy = HookEventMap['thread:update']['updatedBy'];
type ToolAccessMode = 'all' | 'allow_list' | 'deny_list' | null;

/**
 * thread op `update`: the thread's own settings. Who is in the thread is ops
 * add_agents, remove_agents and leave (threadMembers.ts, threadLeave.ts), so
 * a settings change can never take an agent out.
 */
interface ThreadUpdateInput {
  thread_id?: unknown;
  thread?: unknown;
}

const THREAD_KEYS = new Set([
  'title',
  'project_id',
  'dispatch_mode',
  'system_prompt',
  'max_waves',
  'max_total_output_tokens',
  'max_agent_dispatches',
  'tool_access_mode',
  'tool_access_allow_list',
  'tool_access_deny_list',
  'working_directory',
]);
const TOOL_ACCESS_MODES = new Set(['all', 'allow_list', 'deny_list']);
const DISPATCH_MODES = new Set(['all', 'mentioned']);
const TOP_LEVEL_KEYS = new Set(['thread_id', 'thread']);

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`thread_update: ${label} contains unknown field(s): ${unknown.join(', ')}.`);
  }
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new Error(`thread_update: ${label} must be a string or null.`);
}

function nullableNonEmptyString(value: unknown, label: string): string | null {
  if (value === null) return null;
  const parsed = asNonEmptyString(value);
  if (parsed) return parsed;
  throw new Error(`thread_update: ${label} must be a non-empty string or null.`);
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw new Error(`thread_update: ${label} must be an integer or null.`);
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  const parsed = nullableInteger(value, label);
  if (parsed === null || parsed > 0) return parsed;
  throw new Error(`thread_update: ${label} must be a positive integer or null.`);
}

function nullableStringArray(value: unknown, label: string): string[] | null {
  if (value === null) return null;
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
  ) {
    return [...value];
  }
  throw new Error(`thread_update: ${label} must be an array of non-empty strings or null.`);
}

function toolAccessMode(value: unknown, label: string): ToolAccessMode {
  if (value === null) return null;
  if (typeof value === 'string' && TOOL_ACCESS_MODES.has(value)) {
    return value as Exclude<ToolAccessMode, null>;
  }
  throw new Error(`thread_update: ${label} must be 'all', 'allow_list', 'deny_list', or null.`);
}

/**
 * A thread's project target must be a project container. The model repeats
 * this check when it writes, but resolving it here lets the error name the
 * nearest project above a plain container that was passed by mistake.
 */
async function assertProjectTarget(projectId: string): Promise<void> {
  const target = await Containers.findById(projectId);
  if (!target) throw new Error(`thread_update: project '${projectId}' not found.`);
  if (target.category === 'project') return;
  const nearest = await Projects.nearestProjectForContainer(projectId);
  const hint = nearest
    ? `The nearest project above it is '${nearest}'; pass that as thread.project_id.`
    : 'No project encloses it; pass a project container id, or null to make the thread flat.';
  throw new Error(
    `thread_update: '${projectId}' is a ${target.category ?? 'plain'} container, not a project — threads attach to a project, not to any other container. ${hint}`
  );
}

function currentUpdatedBy(): UpdatedBy {
  const actor = getCurrentActor();
  return actor
    ? { kind: actor.actorKind, ...(actor.actorKind === 'system' ? {} : { id: actor.actorId }) }
    : { kind: 'system' };
}

interface ParsedThreadPatch {
  patch: UpdateThreadInput;
  changed: string[];
  /** The folder agents start in: a path to set, null to clear, undefined = not asked. */
  workingDirectory: string | null | undefined;
}

function parseThreadPatch(raw: unknown): ParsedThreadPatch {
  if (raw === undefined) return { patch: {}, changed: [], workingDirectory: undefined };
  if (!isRecord(raw)) throw new Error('thread_update: `thread` must be an object.');
  rejectUnknownKeys(raw, THREAD_KEYS, '`thread`');

  const patch: UpdateThreadInput = {};
  const changed: string[] = [];
  const assign = <K extends keyof UpdateThreadInput>(
    inputKey: string,
    outputKey: K,
    parse: (value: unknown, label: string) => UpdateThreadInput[K]
  ) => {
    if (!hasOwn(raw, inputKey)) return;
    patch[outputKey] = parse(raw[inputKey], `thread.${inputKey}`);
    changed.push(`thread.${inputKey}`);
  };

  assign('title', 'title', nullableString);
  assign('project_id', 'projectId', nullableNonEmptyString);
  if (hasOwn(raw, 'dispatch_mode')) {
    if (typeof raw.dispatch_mode !== 'string' || !DISPATCH_MODES.has(raw.dispatch_mode)) {
      throw new Error("thread_update: thread.dispatch_mode must be 'all' or 'mentioned'.");
    }
    patch.dispatchMode = raw.dispatch_mode as UpdateThreadInput['dispatchMode'];
    changed.push('thread.dispatch_mode');
  }
  assign('system_prompt', 'threadSystemPrompt', nullableString);
  if (hasOwn(raw, 'max_waves')) {
    const value = nullableInteger(raw.max_waves, 'thread.max_waves');
    if (value !== null && value !== -1 && value <= 0) {
      throw new Error('thread_update: thread.max_waves must be -1, null, or a positive integer.');
    }
    patch.maxWaves = value;
    changed.push('thread.max_waves');
  }
  assign('max_total_output_tokens', 'maxTotalOutputTokens', nullablePositiveInteger);
  assign('max_agent_dispatches', 'maxAgentDispatches', nullablePositiveInteger);
  assign('tool_access_mode', 'toolAccessMode', toolAccessMode);
  assign('tool_access_allow_list', 'toolAccessAllowList', nullableStringArray);
  assign('tool_access_deny_list', 'toolAccessDenyList', nullableStringArray);
  // Not a column of the settings patch: it has its own checked setter (below).
  let workingDirectory: string | null | undefined;
  if (hasOwn(raw, 'working_directory')) {
    workingDirectory = nullableNonEmptyString(raw.working_directory, 'thread.working_directory');
    changed.push('thread.working_directory');
  }
  return { patch, changed, workingDirectory };
}

const handler: ToolHandler = async (input, _settings, context) => {
  if (!isRecord(input)) throw new Error('thread_update: input must be an object.');
  if (
    hasOwn(input, 'participants') ||
    hasOwn(input, 'agent_ids') ||
    hasOwn(input, 'remove_agent_ids')
  ) {
    throw new Error(
      'thread_update: update changes thread settings only. Add agents with op "add_agents" and remove them with op "remove_agents" (yourself: op "leave"); per-agent settings are changed by people in the Snaglet app.'
    );
  }
  rejectUnknownKeys(input, TOP_LEVEL_KEYS, 'input');
  const args = input as ThreadUpdateInput;
  const updatedBy = currentUpdatedBy();
  // Defaults to the calling thread.
  const threadId = await resolveTargetThreadId(input, context, 'thread_update');

  const {
    patch: threadPatch,
    changed: threadChanged,
    workingDirectory,
  } = parseThreadPatch(args.thread);
  if (threadChanged.length === 0) {
    throw new Error('thread_update: provide `thread` fields to change.');
  }

  const existing = await Threads.findById(threadId);
  if (!existing) throw await threadNotFoundError('thread_update', threadId, context);
  await assertNotDmThread('thread op:update', threadId, context, { allowOwnThread: false });
  if (typeof threadPatch.projectId === 'string') await assertProjectTarget(threadPatch.projectId);

  // The folder must be a real folder inside the project's folder (the same
  // checks as the settings screen), so it is settled before anything is written.
  let checkedWorkingDirectory: string | null | undefined;
  if (workingDirectory !== undefined) {
    if (workingDirectory === null) {
      checkedWorkingDirectory = null;
    } else {
      const project = await findProjectAncestor(threadId);
      try {
        checkedWorkingDirectory = await validateThreadWorkingDirectory(
          workingDirectory,
          project?.folderPath ?? null
        );
      } catch (error) {
        throw new Error(
          `thread_update: thread.working_directory: ${getErrorMessage(error, 'invalid folder')}`
        );
      }
    }
  }

  let updatedThread = existing;
  if (Object.keys(threadPatch).length > 0) {
    const row = await Threads.updateSettings(threadId, threadPatch);
    if (!row) throw new Error(`thread_update: thread '${threadId}' disappeared during update.`);
    updatedThread = row;
  }
  if (checkedWorkingDirectory !== undefined) {
    const row = await Threads.setWorkingDirectory(threadId, checkedWorkingDirectory);
    if (!row) throw new Error(`thread_update: thread '${threadId}' disappeared during update.`);
    updatedThread = row;
  }

  const changed = threadChanged;

  const updatedAt = updatedThread.updatedAt ?? updatedThread.createdAt;
  const titleChanged = threadChanged.includes('thread.title');
  const projectChanged = existing.projectId !== updatedThread.projectId;
  if (projectChanged) {
    hooks.emit('thread:move', {
      id: threadId,
      fromProjectId: existing.projectId,
      toProjectId: updatedThread.projectId,
      fromContainerId: existing.projectId,
      toContainerId: updatedThread.projectId,
    });
  }
  if (titleChanged || projectChanged) {
    // A thread's tree parent is its project (null = the flat Threads list).
    emitTreeNodeUpdated({
      id: updatedThread.id,
      kind: 'thread',
      ...(titleChanged ? { title: updatedThread.title ?? '' } : {}),
      ...(projectChanged ? { parentId: updatedThread.projectId } : {}),
      updatedAt,
    });
  }
  emitThreadUpdated({
    id: updatedThread.id,
    ...(titleChanged ? { title: updatedThread.title ?? '' } : {}),
    updatedAt,
  });
  hooks.emit('thread:update', {
    id: threadId,
    updatedBy,
    changed,
    participantAgentIds: [],
    removedAgentIds: [],
  });

  // Say where agents start now (the saved folder, or the project's, or Snaglet home).
  const startsIn =
    checkedWorkingDirectory !== undefined ? (await describeAgentCwd(threadId)).path : null;

  return {
    output:
      `Updated thread '${updatedThread.title ?? threadId}' (id=${threadId}).\n` +
      `Changed: ${changed.join(', ')}` +
      (startsIn ? `\nAgents in this thread now start in: ${startsIn}` : ''),
    rawContent: {
      thread_id: threadId,
      project_id: updatedThread.projectId,
      changed,
      updated_by: updatedBy,
      ...(startsIn ? { working_directory: checkedWorkingDirectory, starts_in: startsIn } : {}),
    },
  };
};

export default handler;
