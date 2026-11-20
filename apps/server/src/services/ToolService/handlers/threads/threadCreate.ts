import { transaction } from '@snaglet/db/db';
import { Threads, type ThreadRow } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { Agents } from '@snaglet/db/tables/agents';
import { Containers } from '@snaglet/db/tables/containers';
import { Nodes } from '@snaglet/db/tables/nodes';
import { Projects } from '@snaglet/db/tables/projects';
import { Users } from '@snaglet/db/tables/users';
import { asNonEmptyString, generateId, getErrorMessage, unique } from '@snaglet/shared/utils';
import { emitThreadCreated, snapshotFromThreadNode } from '@server/realtime/surfaces/threads';
import { emitTreeNodeCreated, snapshotFromThread } from '@server/realtime/surfaces/tree';
import { emitThreadCreate } from '@server/services/customHooks/threadCreateEvent';
import { postAgentMessageToThread } from '@server/services/ThreadDeliveryPolicyService';
import type { ToolHandler } from '@server/services/ToolService/types';
import { withCrossThreadFooter } from './crossThreadFooter';

interface ThreadCreateInput {
  title?: unknown;
  project_id?: unknown;
  container_id?: unknown;
  dispatch_mode?: unknown;
  agent_ids?: unknown;
  system_prompt?: unknown;
  initial_message?: unknown;
}

/**
 * Every local user joins a new thread: Snaglet is local-first, so each `users` row is
 * a person on this machine. Only an empty table falls back to creating the
 * local user. Agents never choose the human roster.
 */
async function resolveHumanParticipants(): Promise<string[]> {
  const users = await Users.list({ orderBy: 'id', order: 'ASC' });
  if (users.length > 0) return unique(users.map((u) => u.id));
  return [(await Users.getOrCreateLocalUser()).id];
}

const handler: ToolHandler = async (input, _settings, context) => {
  const args = (input ?? {}) as ThreadCreateInput;

  // Renamed / removed params fail loudly with the replacement instead of being
  // silently ignored (a dropped roster would create a thread nobody answers in).
  if (Object.prototype.hasOwnProperty.call(args, 'participant_agent_ids')) {
    return { output: 'thread_create: `participant_agent_ids` was renamed — pass `agent_ids`.' };
  }
  if (Object.prototype.hasOwnProperty.call(args, 'participant_user_ids')) {
    return {
      output:
        'thread_create: `participant_user_ids` was removed — create adds every local user automatically.',
    };
  }
  if (Object.prototype.hasOwnProperty.call(args, 'agents')) {
    return {
      output:
        'thread_create: `agents` was removed — pass `agent_ids`. Per-agent prompt addenda are set by people in the Snaglet app.',
    };
  }

  const title = asNonEmptyString(args.title);
  if (!title) {
    return { output: 'thread_create: `title` is required (non-empty string).' };
  }

  // dispatch_mode: validate against schema enum, default 'mentioned'. Accept
  // the user-facing 'mention' alias as a synonym for the canonical 'mentioned'.
  let dispatchMode: 'all' | 'mentioned' = 'mentioned';
  if (args.dispatch_mode !== undefined && args.dispatch_mode !== null) {
    const raw = args.dispatch_mode;
    if (raw === 'all') {
      dispatchMode = 'all';
    } else if (raw === 'mention' || raw === 'mentioned') {
      dispatchMode = 'mentioned';
    } else {
      return {
        output: `thread_create: invalid dispatch_mode '${String(raw)}'. Must be 'all' or 'mentioned'.`,
      };
    }
  }

  if (Object.prototype.hasOwnProperty.call(args, 'container_id')) {
    return {
      output:
        'thread_create: `container_id` is not a thread parameter — threads attach to a project, not to any other container. Pass `project_id` (a project container id, or null for a flat workspace-level thread).',
    };
  }

  // Resolve the project scope: an explicit value wins (null = flat);
  // otherwise the new thread inherits the calling thread's project.
  let projectId: string | null;
  if (Object.prototype.hasOwnProperty.call(args, 'project_id')) {
    const raw = args.project_id;
    if (raw !== null && !asNonEmptyString(raw)) {
      return { output: 'thread_create: `project_id` must be a project container id or null.' };
    }
    projectId = raw === null ? null : asNonEmptyString(raw);
  } else if (context?.threadId) {
    projectId = await Nodes.getProjectId(context.threadId);
  } else {
    projectId = null;
  }
  if (projectId !== null) {
    const target = await Containers.findById(projectId);
    if (!target) {
      return { output: `thread_create: project '${projectId}' not found — nothing was created.` };
    }
    if (target.category !== 'project') {
      const nearest = await Projects.nearestProjectForContainer(projectId);
      const hint = nearest
        ? `The nearest project above it is '${nearest}'; pass that as project_id.`
        : 'No project encloses it; pass a project container id, or null for a flat thread.';
      return {
        output: `thread_create: '${projectId}' is a ${target.category ?? 'plain'} container, not a project — threads attach to a project, not to any other container. ${hint}`,
      };
    }
  }

  // Validate agent_ids if provided, and pre-resolve every agent
  // so we fail fast before mutating state.
  let participantIds: string[] = [];
  if (args.agent_ids !== undefined && args.agent_ids !== null) {
    if (!Array.isArray(args.agent_ids)) {
      return { output: 'thread_create: `agent_ids` must be an array of agent IDs.' };
    }
    const cleaned: string[] = [];
    for (const entry of args.agent_ids) {
      const id = asNonEmptyString(entry);
      if (!id) {
        return {
          output: 'thread_create: `agent_ids` contains an empty or non-string entry.',
        };
      }
      cleaned.push(id);
    }
    // De-dup while preserving order.
    participantIds = unique(cleaned);
    for (const agentId of participantIds) {
      const agent = await Agents.findById(agentId);
      if (!agent) {
        return { output: `thread_create: agent '${agentId}' not found — nothing was created.` };
      }
    }
  }

  // The human roster is never an agent's choice: every local user joins.
  const participantUserIds = await resolveHumanParticipants();

  const initialMessage = asNonEmptyString(args.initial_message);
  if (initialMessage && !context?.agentId) {
    return {
      output:
        'thread_create: `initial_message` requires a calling agent context (ctx.agentId) so the message can be authored. Omit the field or call from an agent runtime.',
    };
  }
  // Mutations begin here. All preflight checks above must pass first.

  const systemPrompt = asNonEmptyString(args.system_prompt) ?? null;

  const id = generateId('thread');
  // The thread system prompt lives on threads.thread_system_prompt, which the
  // resolver (and therefore threadSystemPromptBlock) reads, so it is set
  // directly at creation in one write rather than via config_json.systemPrompt.
  // An archived project is refused by the model (400); surface that as the
  // tool's own error rather than a stack trace.
  //
  // The thread and its first participants commit together: a failed
  // participant write rolls the thread back instead of leaving an orphan.
  // Events below fire only once everything is committed. Only a failure
  // before the thread row is written becomes the tool's own error; a
  // participant failure still throws, as it did before.
  let threadWritten = false;
  let thread: ThreadRow;
  try {
    thread = await transaction(async (tx) => {
      const created = await Threads.create(
        {
          id,
          title,
          projectId,
          dispatchMode,
          threadSystemPrompt: systemPrompt,
        },
        tx
      );
      threadWritten = true;

      for (const agentId of participantIds) {
        await ThreadParticipants.addParticipant({ threadId: id, agentId }, tx);
      }
      for (const userId of participantUserIds) {
        await ThreadParticipants.addUserParticipant({ threadId: id, userId }, tx);
      }
      return created;
    });
  } catch (err) {
    if (threadWritten) throw err;
    return { output: `thread_create: ${getErrorMessage(err)}` };
  }

  let initialMessageId: string | null = null;
  if (initialMessage && context?.agentId) {
    // Same origin footer thread op:send adds: the agents woken here have no
    // other signal that this came from another conversation, or where to
    // reply. Skipped without thread context (headless runs); lookups are
    // decoration and never fail the creation.
    const content = await withCrossThreadFooter({
      kind: 'created',
      content: initialMessage,
      agentId: context.agentId,
      originThreadId: context.threadId,
      targetThreadId: id,
    });
    const { messageId } = await postAgentMessageToThread({
      threadId: id,
      content,
      agentId: context.agentId,
    });
    initialMessageId = messageId;
  }

  emitTreeNodeCreated(snapshotFromThread(thread));
  emitThreadCreated(snapshotFromThreadNode(thread));
  // After participants + system prompt are persisted — the shared builder
  // reads them from the DB. The calling agent is the creator.
  emitThreadCreate(id, context?.agentId ? { kind: 'agent', id: context.agentId } : undefined);

  const summary = [
    `Created thread '${title}' (id=${id})`,
    `  dispatch_mode: ${dispatchMode}`,
    `  project_id:    ${projectId ?? '(none — flat)'}`,
    // Only appended when provided, so a minimal call's output is byte-identical
    // to before these fields existed.
    systemPrompt ? `  system_prompt: set (${systemPrompt.length} chars)` : null,
    `  participants:  ${participantIds.length === 0 ? '(none)' : participantIds.join(', ')}`,
    `  human_participants: ${participantUserIds.length === 0 ? '(none)' : participantUserIds.join(', ')}`,
    initialMessageId ? `  initial_message_id: ${initialMessageId}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    output: summary,
    rawContent: {
      thread_id: id,
      title,
      project_id: projectId,
      dispatch_mode: dispatchMode,
      system_prompt: systemPrompt,
      agent_ids: participantIds,
      participant_user_ids: participantUserIds,
      initial_message_id: initialMessageId,
    },
  };
};

export default handler;
