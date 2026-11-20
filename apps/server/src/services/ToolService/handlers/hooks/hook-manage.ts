import { HookRegistrations } from '@snaglet/db/tables/hook_registrations';
import { getHookRegistry } from '@server/services/customHooks/HookRegistryService';
import { hookWorkspaceService } from '@server/services/customHooks/HookWorkspaceService';
import { emitHookEnabledChanged } from '@server/realtime/surfaces/hookRuns';
import { hookRunAsSaveError, resolveHookRunAsAgent } from '@server/services/customHooks/hookRunAs';
import type { ToolHandler } from '@server/services/ToolService/types';

function requireHookName(input: Record<string, unknown>): string {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new Error('name is required');
  return name;
}

async function requireRegistered(name: string) {
  const row = await HookRegistrations.findByName(name);
  if (!row) throw new Error(`Hook "${name}" is not registered`);
  return row;
}

/**
 * hook(op:update): replace an existing hook's hook.ts, then rebuild it. The
 * enabled state is left exactly as it was (same as file(op:update) on the
 * source), and the build error is returned when compilation fails. New code
 * puts the hook's unattended policy back to `skip` (the rebuild does it, see
 * HookRegistrations.setBuildState); a person chooses again.
 */
export const updateHook: ToolHandler = async (input) => {
  const name = requireHookName(input);
  if (typeof input.hook_source !== 'string' || !input.hook_source.trim()) {
    throw new Error('hook_source is required for op "update"');
  }
  const before = await requireRegistered(name);
  await hookWorkspaceService.updateFiles(name, { 'hook.ts': input.hook_source });
  const registry = getHookRegistry();
  await registry.registerHookFolder(name);
  const row = await requireRegistered(name);
  if (row.buildStatus === 'failed') {
    throw new Error(
      `Updated ${name}, but it failed to build:\n${row.lastError ?? 'Unknown build error'}`
    );
  }
  return JSON.stringify({
    hook_name: name,
    updated: true,
    enabled: row.enabled,
    enabled_unchanged: row.enabled === before.enabled,
    build_status: row.buildStatus,
    unattended_policy: row.unattendedPolicy,
  });
};

function setEnabledHandler(enabled: boolean): ToolHandler {
  return async (input) => {
    const name = requireHookName(input);
    const before = await requireRegistered(name);
    // Idempotent: repeating the current state writes and announces nothing.
    if (before.enabled === enabled) {
      return JSON.stringify({ hook_name: name, enabled, changed: false });
    }
    const row = await getHookRegistry().setEnabled(name, enabled);
    if (!row) throw new Error(`Hook "${name}" is not registered`);
    emitHookEnabledChanged(row.name, row.enabled);
    return JSON.stringify({ hook_name: name, enabled: row.enabled, changed: true });
  };
}

export const enableHook = setEnabledHandler(true);
export const disableHook = setEnabledHandler(false);

/**
 * hook(op:run_as): set the agent a hook runs as (`run_as`: an agent id or
 * name), or clear it (`""` or null) back to the default: the event's agent,
 * else the ghost system actor. The hook's tool calls are then judged by that
 * agent's own access and what it posts or writes carries that agent's name.
 *
 * Capability guards: hook code can never change it (a call from a hook run is
 * refused), and an agent may name only itself and clear only a run as naming
 * itself; a person at the panel, with no agent context, may set or clear any.
 * Archived, helper, missing and ghost agents are refused here and again
 * before every run.
 */
export const setHookRunAs: ToolHandler = async (input, _settings, context) => {
  const name = requireHookName(input);
  if (context?.hookOrigin) {
    throw new Error(
      'Hook code cannot change which agent a hook runs as. A person sets it in the hook editor.'
    );
  }
  if (!('run_as' in input)) {
    throw new Error('run_as is required for op "run_as": an agent id or name, or "" to clear it');
  }
  const raw = input.run_as;
  if (raw !== null && typeof raw !== 'string') {
    throw new Error('run_as must be an agent id or name, or "" to clear it');
  }
  const ref = (raw ?? '').trim();
  const before = await requireRegistered(name);
  let agentRef: string | null = ref || null;
  // Clearing is a change of identity too (back to the event's agent or the
  // system actor): an agent may clear only a run as that names itself.
  if (
    !agentRef &&
    context?.agentId &&
    before.runAsAgentId &&
    before.runAsAgentId !== context.agentId
  ) {
    throw new Error(
      `This hook runs as ${before.runAsAgentId}; an agent can clear only a run as that names ` +
        'itself. A person changes it in the hook editor.'
    );
  }
  if (agentRef && context?.agentId) {
    const resolved = await resolveHookRunAsAgent(agentRef);
    if (!resolved.ok) throw hookRunAsSaveError(agentRef, resolved.problem);
    if (resolved.agent.id !== context.agentId) {
      throw new Error(
        `An agent can set a hook to run only as itself (${context.agentId}). ` +
          'A person picks any other agent in the hook editor.'
      );
    }
    agentRef = resolved.agent.id;
  }
  const row = await getHookRegistry().setRunAs(name, agentRef);
  if (!row) throw new Error(`Hook "${name}" is not registered`);
  return JSON.stringify({
    hook_name: name,
    run_as: row.runAsAgentId,
    changed: row.runAsAgentId !== before.runAsAgentId,
    note: row.runAsAgentId
      ? `Runs as ${row.runAsAgentId}: its tool access applies and its name goes on what the hook posts and writes.`
      : "Runs as the event's agent, else the system actor (ghost).",
  });
};
