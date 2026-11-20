/**
 * AgentService — local agent registry stored in the database.
 *
 * Manages Snaglet agent configs: identity, model, provider, avatar, and system
 * prompt.
 *
 * All config fields are flat columns on public.agents; there is no
 * config_json blob. AgentRow carries typed fields directly.
 */

import { getErrorMessage, AppError, slugifyAgentName } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import type { SnagletAgent } from '@snaglet/shared/types';
import {
  GHOST_AGENT_ID,
  GHOST_AGENT_NAME,
  GHOST_HOOK_LABEL,
  isReservedActorName,
} from '@snaglet/shared/constants';
import { hooks } from './HookService';
import { emitAgentCreate } from './customHooks/agentCreateEvent';
import {
  emitAgentCreated,
  emitAgentDeleted,
  emitAgentRowChanges,
  emitAgentUpdated,
} from '@server/realtime/surfaces/agents';
import {
  Agents,
  type AgentRow,
  type AgentPurgeResult,
  type UpdateAgentInput,
} from '@snaglet/db/tables/agents';
import { Models } from '@snaglet/db/tables/models';
import { Nodes } from '@snaglet/db/tables/nodes';
import { Threads } from '@snaglet/db/tables/threads';
import { emitThreadDeleted } from '@server/realtime/surfaces/threads';
import { emitTreeNodeDeleted } from '@server/realtime/surfaces/tree';
import { withThreadExecutionPurge } from './ThreadExecutionPurgeService';
import { emitTableEntriesChanged } from '@server/realtime/surfaces/tables';
import { withGuardedConfirmationDefaults } from './ToolService/lib/guardedTools';
import { STARTER_AGENTS, starterAgentDefaults } from './onboarding/starterAgents';
import { resolveAgentConfig } from './ConfigResolverService';
import { logger } from '@server/config/logger';
import {
  agentThreadIds,
  markThreadsRosterChanged,
} from './SocketService/dispatch/agentRosterChanges';

export type { SnagletAgent };

function duplicateAgentNameError(name: string): AppError {
  return new AppError(
    `An agent named "${name}" already exists`,
    ErrorCode.CONFLICT,
    HTTP_STATUS.CONFLICT
  );
}

/** Rejects a create/rename to the reserved ghost name (case-insensitive) with a
 *  clear message instead of leaking a raw unique-constraint violation. */
function reservedNameError(): AppError {
  return new AppError(
    `"${GHOST_AGENT_NAME}" and "${GHOST_HOOK_LABEL}" are reserved system names and cannot be used for an agent`,
    ErrorCode.VALIDATION_ERROR,
    HTTP_STATUS.BAD_REQUEST
  );
}

/** Rejects any mutation (delete / archive / rename) of the permanent ghost
 *  system agent — the service layer of the three-layer undeletable guard. */
function ghostProtectedError(action: string): AppError {
  return new AppError(
    `The ghost system agent is permanent and cannot be ${action}`,
    ErrorCode.FORBIDDEN,
    HTTP_STATUS.FORBIDDEN
  );
}

function unusableAgentNameError(name: string): AppError {
  return new AppError(
    `Agent name "${name}" has no usable characters for an id`,
    ErrorCode.VALIDATION_ERROR,
    HTTP_STATUS.BAD_REQUEST
  );
}

/**
 * Validate a rename with create's rules — not reserved, usable characters,
 * unique case-insensitively among OTHER agents (re-casing your own name is
 * fine). The id is not re-derived: it stays stable across renames.
 */
async function validatedRename(agentId: string, requested: unknown): Promise<string> {
  const name = typeof requested === 'string' ? requested.trim() : '';
  if (!name) {
    throw new AppError(
      'name must be a non-empty string',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  if (isReservedActorName(name)) throw reservedNameError();
  if (!slugifyAgentName(name)) throw unusableAgentNameError(name);
  const holder = await Agents.findByName(name);
  if (holder && holder.id !== agentId) throw duplicateAgentNameError(name);
  return name;
}

function isDuplicateAgentNameError(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  if (e?.code !== '23505') return false;
  return (
    e.constraint === 'agents_name_lower_key' ||
    e.constraint === 'agents_name_key' ||
    e.constraint === 'agents_pkey' ||
    /agents_(name|pkey)/i.test(getErrorMessage(err))
  );
}

export type SnagletAgentCreate = Omit<
  SnagletAgent,
  'id' | 'createdAt' | 'updatedAt' | 'archived' | 'archivedAt' | 'deletedAt'
>;
export type SnagletAgentUpdate = Partial<
  Omit<SnagletAgent, 'id' | 'createdAt' | 'updatedAt' | 'archived' | 'archivedAt' | 'deletedAt'>
>;

/**
 * Remove every DM thread the agent is in, with its runs and activity,
 * before the agent itself goes: a DM is meaningless without both parties, and
 * the ghost repoint would otherwise leave it behind. Messages and participants
 * go with the thread node (cascade). Any failure fails the agent delete, so no
 * DM thread is orphaned: an app error (a run still active in one of the
 * threads is a 409 ConflictError) is rethrown as it is, anything else becomes
 * a 500 that says the agent was not deleted. The thread-deleted events go out
 * after the commit and are best-effort: the threads are gone by then, so a
 * failed emit must not report the delete as failed.
 */
async function deleteDmThreadsOf(agentId: string): Promise<void> {
  if (!(await Agents.findById(agentId))) return;
  const threadIds = await Threads.listDmIdsForAgent(agentId);
  if (threadIds.length === 0) return;
  try {
    // The user's home thread with this agent goes too: the one delete that
    // may take a home thread.
    await withThreadExecutionPurge(
      threadIds,
      async ({ tx }) => {
        for (const threadId of threadIds) await Nodes.deleteOfType(threadId, 'thread', tx);
      },
      { allowsHomeThreads: true }
    );
  } catch (err) {
    logger.error(`[agents] could not delete DM threads of ${agentId}: ${getErrorMessage(err)}`);
    if (err instanceof AppError) throw err;
    throw new AppError(
      `Could not delete the agent's DM threads, so the agent was not deleted: ${getErrorMessage(err)}`,
      ErrorCode.INTERNAL_ERROR,
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    );
  }
  // After the commit, like every other thread delete, so open views drop them.
  for (const threadId of threadIds) {
    try {
      emitTreeNodeDeleted(threadId, 'thread');
      emitThreadDeleted(threadId);
    } catch (err) {
      logger.warn(
        `[agents] DM thread ${threadId} of ${agentId} was deleted but its delete event failed: ${getErrorMessage(err)}`
      );
    }
  }
}

async function warnIfModelMetadataMissing(provider: string, modelId: string): Promise<void> {
  if (!provider || !modelId) return;
  try {
    const row = await Models.findByProviderAndModelId(provider, modelId);
    if (!row) {
      logger.warn(
        `[agents] Selected model ${provider}/${modelId} has no registry row — ` +
          `context budget will use defaults. Run model discovery to register it.`
      );
    } else if (row.maxOutputTokens == null) {
      logger.warn(
        `[agents] Model ${provider}/${modelId} is missing max_output_tokens metadata — ` +
          `falling back to the 4096 default. Re-run model discovery or backfill the registry row.`
      );
    }
  } catch (err) {
    logger.warn(`[agents] Model metadata check failed: ${getErrorMessage(err)}`);
  }
}

async function rowToAgent(row: AgentRow): Promise<SnagletAgent> {
  const resolved = await resolveAgentConfig(row);

  return {
    id: row.id,
    name: row.name,
    role: row.role ?? undefined,
    avatarUrl: row.avatarUrl ?? undefined,
    credentialId: row.credentialId,
    modelId: resolved.modelId,
    identity: resolved.identity,
    // rawIdentity = stored value before wiki-link expansion — used by the
    // editor, mirroring rawSystemPrompt below. Feeding the EXPANDED identity
    // to the editor renders `<doc id=…>` wrappers as literal text (the
    // Identity-input embed bug); the raw channel keeps `![](doc-id)` chips
    // renderable and round-trippable.
    rawIdentity: row.identity ?? null,
    provider: resolved.provider,
    // rawSystemPrompt = stored value before wiki-link expansion — used by the editor.
    // Keep: AgentView.tsx displays this instead of the expanded systemPrompt.
    rawSystemPrompt: row.systemPrompt ?? null,
    systemPrompt: resolved.systemPrompt ?? row.systemPrompt ?? '',
    toolAccessMode: row.toolAccessMode,
    toolAccessAllowList: row.toolAccessAllowList,
    toolAccessDenyList: row.toolAccessDenyList,
    toolAccessAdvertiseAllowedOnly: row.toolAccessAdvertiseAllowedOnly === true,
    dmEnabled: row.dmEnabled,
    mcpServers: row.mcpServers,
    toolOverrides: row.toolOverrides,
    trustedToolCalls: row.trustedToolCalls === true,
    maxToolCallsPerTurn: row.maxToolCallsPerTurn,
    maxDurationSeconds: row.maxDurationSeconds,
    fallbacks: row.fallbacks,
    disableModelFallback: row.disableModelFallback,
    voice: row.voice ?? null,
    cursorFlower: row.cursorFlower ?? null,
    cursorColor: row.cursorColor ?? null,
    cursorSpec: (row.cursorSpec as SnagletAgent['cursorSpec']) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
    archived: row.archived,
    archivedAt: row.archivedAt,
    deletedAt: row.deletedAt,
    parentAgentId: row.parentAgentId ?? null,
  };
}

let seededDefaults = false;
let seedDefaultsPromise: Promise<void> | null = null;

async function ensureDefaults(): Promise<void> {
  if (seededDefaults) return;

  // Several UI surfaces can ask for agents during the same first render. Share
  // one initialization attempt so they cannot all observe an empty roster and
  // race to insert the same deterministic default ids.
  const attempt =
    seedDefaultsPromise ??
    (seedDefaultsPromise = (async () => {
      // includeArchived: an all-archived workspace still "has agents" — seeding
      // the starter agents again would resurrect them behind the user's back
      // (and could collide on the unique name index once one is restored).
      // Count every agent.
      const rows = await Agents.list({ limit: 1, includeArchived: true });
      if (rows.length === 0) {
        // Starter agents ship guarded like any other new agent: shell/file/
        // destructive tools ask a human before running (see guardedTools).
        // No provider or model: each adopts a connected one on its first run.
        const guardedOverrides = await withGuardedConfirmationDefaults(null);
        for (const agent of STARTER_AGENTS) {
          await Agents.create({
            id: agent.id,
            name: agent.name,
            role: agent.role,
            ...starterAgentDefaults(agent),
            toolOverrides: guardedOverrides,
          });
        }
      }
      seededDefaults = true;
    })());

  try {
    await attempt;
  } finally {
    // A failed attempt must be retryable. The identity check prevents an older
    // rejected waiter from clearing a newer retry that has already started.
    if (seedDefaultsPromise === attempt) seedDefaultsPromise = null;
  }
}

export const agentService = {
  async list(opts?: { includeArchived?: boolean }): Promise<SnagletAgent[]> {
    await ensureDefaults();
    const rows = await Agents.list({ limit: 1000, includeArchived: opts?.includeArchived });
    return Promise.all(rows.map(rowToAgent));
  },

  async get(id: string): Promise<SnagletAgent | undefined> {
    await ensureDefaults();
    const row = await Agents.findById(id);
    if (!row) return undefined;
    return rowToAgent(row);
  },

  async create(data: SnagletAgentCreate): Promise<SnagletAgent> {
    // "ghost" is reserved for the system attribution actor — reject up front with
    // a clear message (the seeded ghost row already owns the unique lower(name)
    // index, so this would otherwise surface as an opaque conflict). Refusals
    // run before ensureDefaults: first-use seeding loads the whole tool registry
    // and a rejected request has no reason to pay for it.
    if (isReservedActorName(data.name)) throw reservedNameError();
    await ensureDefaults();
    if (await Agents.findByName(data.name)) throw duplicateAgentNameError(data.name);

    const agentId = slugifyAgentName(data.name);
    if (!agentId) throw unusableAgentNameError(data.name);
    if (await Agents.findById(agentId)) throw duplicateAgentNameError(data.name);

    await warnIfModelMetadataMissing(data.provider ?? '', data.modelId ?? '');

    let row: AgentRow;
    try {
      row = await Agents.create({
        id: agentId,
        name: data.name,
        role: data.role,
        avatarUrl: data.avatarUrl,
        systemPrompt: data.rawSystemPrompt ?? (data.systemPrompt || null),
        identity: data.identity || null,
        modelId: data.modelId || null,
        providerId: data.provider || null,
        credentialId: data.credentialId || null,
        toolAccessMode: data.toolAccessMode ?? null,
        toolAccessAllowList: data.toolAccessAllowList ?? null,
        toolAccessDenyList: data.toolAccessDenyList ?? null,
        toolAccessAdvertiseAllowedOnly: data.toolAccessAdvertiseAllowedOnly ?? false,
        // mcp_servers is NOT NULL DEFAULT '[]'; never write null (the create
        // route sends null when no servers are selected) — coerce to an empty list.
        mcpServers: data.mcpServers ?? [],
        // Guarded-by-default: new agents get requiresConfirmation:true for the
        // guarded set (call-time-guarded kinds + destructive builtins) unless
        // the caller explicitly set a per-tool value. Creation-time data only —
        // update() never touches overrides, so existing rows are untouched.
        toolOverrides: await withGuardedConfirmationDefaults(data.toolOverrides ?? null),
        trustedToolCalls: data.trustedToolCalls === true,
        maxToolCallsPerTurn: data.maxToolCallsPerTurn ?? null,
        maxDurationSeconds: data.maxDurationSeconds ?? null,
        fallbacks: data.fallbacks ?? null,
        disableModelFallback: data.disableModelFallback ?? false,
        voice: data.voice ?? null,
        cursorFlower: data.cursorFlower ?? null,
        cursorColor: data.cursorColor ?? null,
        cursorSpec: (data.cursorSpec as Record<string, unknown> | null | undefined) ?? null,
      });
    } catch (err) {
      if (isDuplicateAgentNameError(err)) throw duplicateAgentNameError(data.name);
      throw err;
    }
    const agent = await rowToAgent(row);
    // Fire-and-forget; the shared builder reads the just-written row so the
    // payload carries the full configuration (identity, model, tool access,
    // MCP servers) in the same shape the test console delivers.
    emitAgentCreate(agent.id);
    // Realtime roster invalidation lives here, not in a route, so the HTTP
    // route and the create_agent tool both reach other windows.
    emitAgentCreated(agent.id);
    return agent;
  },

  async update(id: string, data: SnagletAgentUpdate): Promise<SnagletAgent | null> {
    // Ghost cannot be renamed away from its reserved name, and no other agent may
    // be renamed TO "ghost" (case-insensitive). Both refusals come before
    // ensureDefaults (see create); validatedRename re-checks the trimmed name.
    if (id === GHOST_AGENT_ID) throw ghostProtectedError('modified');
    if (typeof data.name === 'string' && isReservedActorName(data.name)) {
      throw reservedNameError();
    }
    await ensureDefaults();
    const changed = Object.keys(data).filter(
      (k) => data[k as keyof SnagletAgentUpdate] !== undefined
    );

    if (data.provider !== undefined || data.modelId !== undefined) {
      await warnIfModelMetadataMissing(data.provider ?? '', data.modelId ?? '');
    }

    const updateInput: UpdateAgentInput = {};
    if (data.name !== undefined) updateInput.name = await validatedRename(id, data.name);
    if (data.role !== undefined) updateInput.role = data.role;
    if (data.avatarUrl !== undefined) updateInput.avatarUrl = data.avatarUrl;
    // systemPrompt on SnagletAgent is the resolved value; we store the raw form.
    // Callers that need to write a raw (wiki-link) value send it as rawSystemPrompt.
    if ((data as Record<string, unknown>).rawSystemPrompt !== undefined) {
      updateInput.systemPrompt = (data as Record<string, unknown>).rawSystemPrompt as string | null;
    } else if (data.systemPrompt !== undefined) {
      updateInput.systemPrompt = data.systemPrompt || null;
    }
    if (data.identity !== undefined) updateInput.identity = data.identity || null;
    if (data.modelId !== undefined) updateInput.modelId = data.modelId || null;
    if (data.provider !== undefined) updateInput.providerId = data.provider || null;
    if (data.credentialId !== undefined) updateInput.credentialId = data.credentialId || null;
    if (data.toolAccessMode !== undefined) updateInput.toolAccessMode = data.toolAccessMode;
    if (data.toolAccessAllowList !== undefined)
      updateInput.toolAccessAllowList = data.toolAccessAllowList;
    if (data.toolAccessDenyList !== undefined)
      updateInput.toolAccessDenyList = data.toolAccessDenyList;
    if (data.toolAccessAdvertiseAllowedOnly !== undefined)
      updateInput.toolAccessAdvertiseAllowedOnly = data.toolAccessAdvertiseAllowedOnly === true;
    // mcp_servers is NOT NULL; a null clear means "no servers" → empty list.
    if (data.mcpServers !== undefined) updateInput.mcpServers = data.mcpServers ?? [];
    if (data.toolOverrides !== undefined) updateInput.toolOverrides = data.toolOverrides;
    if (data.trustedToolCalls !== undefined)
      updateInput.trustedToolCalls = data.trustedToolCalls === true;
    if (data.maxToolCallsPerTurn !== undefined)
      updateInput.maxToolCallsPerTurn = data.maxToolCallsPerTurn;
    if (data.maxDurationSeconds !== undefined)
      updateInput.maxDurationSeconds = data.maxDurationSeconds;
    if (data.fallbacks !== undefined) updateInput.fallbacks = data.fallbacks;
    if (data.disableModelFallback !== undefined)
      updateInput.disableModelFallback = data.disableModelFallback;
    if (data.voice !== undefined) updateInput.voice = data.voice || null;
    if (data.cursorFlower !== undefined) updateInput.cursorFlower = data.cursorFlower || null;
    if (data.cursorColor !== undefined) updateInput.cursorColor = data.cursorColor || null;
    if (data.cursorSpec !== undefined)
      updateInput.cursorSpec =
        (data.cursorSpec as unknown as Record<string, unknown> | null) ?? null;
    if (data.dmEnabled !== undefined) updateInput.dmEnabled = data.dmEnabled;

    // Read before the write so the realtime event names only the fields that
    // actually differed; re-sending an identical value must not make every
    // window refetch.
    const before = await Agents.findById(id);
    let row: AgentRow | null;
    try {
      row = await Agents.update(id, updateInput);
    } catch (err) {
      // A concurrent rename can still win the unique lower(name) index.
      if (updateInput.name !== undefined && isDuplicateAgentNameError(err)) {
        throw duplicateAgentNameError(updateInput.name);
      }
      throw err;
    }
    if (row) {
      hooks.emit('agent:update', { id, changed });
      emitAgentRowChanges(
        id,
        before,
        row,
        Object.keys(updateInput) as Array<keyof UpdateAgentInput & keyof AgentRow>
      );
    }
    return row ? await rowToAgent(row) : null;
  },

  /**
   * Permanently delete an agent via the ghost pattern. Destroys the agent's
   * private trash (memories, thread summaries, owned memories) and repoints
   * every kept reference (messages, runs, activity log, settings, and
   * member-keyed workspace attribution) to the permanent `ghost` system agent,
   * then deletes the agent + member rows for real. History never goes
   * authorless because ghost inherits authorship. See AgentModel.purge.
   *
   * Idempotent + transactional: returns the destroyed/repointed counts, or null
   * if the agent does not exist (a re-delete is a no-op → 404). Throws if `id` is
   * ghost — the service layer of the three-layer undeletable guard (routes +
   * DB trigger being the other two). Emits `agent:delete` so any live surface
   * still holding the agent drops it.
   */
  async purge(id: string): Promise<AgentPurgeResult | null> {
    if (id === GHOST_AGENT_ID) throw ghostProtectedError('deleted');
    await ensureDefaults();
    await deleteDmThreadsOf(id);
    // Read before its participant rows go with it; bumped once they are gone.
    const joinedThreadIds = await agentThreadIds(id);
    const result = await Agents.purge(id);
    if (result) {
      // A run in any of its threads stops routing mentions to it.
      markThreadsRosterChanged(joinedThreadIds);
      hooks.emit('agent:delete', { id });
      emitAgentDeleted(id);
      // Database entries whose agent relations lost their link to it.
      for (const cleared of result.clearedTableLinks ?? [])
        emitTableEntriesChanged(cleared.tableId, cleared.entryIds);
    }
    return result;
  },

  /**
   * Soft-archive an agent — the non-destructive retirement path. The
   * agent keeps all its history (messages/runs/memories/thread_participants
   * rows untouched, attribution intact) but is excluded from dispatch, wake,
   * mention targets, and active rosters/pickers; it appears in the
   * ArchivedDrawer with a restore action. Returns the archived agent, or null if
   * no such agent. Idempotent. Throws if `id` is ghost — ghost cannot be archived
   * (nor swept). Emits `agent:update` so live-roster surfaces refetch and drop it.
   */
  async archive(id: string): Promise<SnagletAgent | null> {
    if (id === GHOST_AGENT_ID) throw ghostProtectedError('archived');
    await ensureDefaults();
    const row = await Agents.archive(id);
    if (row) {
      hooks.emit('agent:update', { id, changed: ['archived'] });
      // No revision: archiving does not bump updated_at, so the row's
      // revision is one an open pane already holds and would skip.
      emitAgentUpdated(id, ['archived']);
      // A run in any of its threads stops routing mentions to it.
      markThreadsRosterChanged(await agentThreadIds(id));
    }
    return row ? await rowToAgent(row) : null;
  },

  /** Restore a soft-archived agent. Returns the restored agent, or null
   *  if no such agent. Idempotent. Emits `agent:update` so rosters refetch. */
  async restore(id: string): Promise<SnagletAgent | null> {
    await ensureDefaults();
    const row = await Agents.restore(id);
    if (row) {
      hooks.emit('agent:update', { id, changed: ['archived'] });
      emitAgentUpdated(id, ['archived']);
    }
    return row ? await rowToAgent(row) : null;
  },
};
