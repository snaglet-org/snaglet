import type { HookRegistrationRow } from '@snaglet/db/tables/hook_registrations/HookRegistrationModel';
import type { HookRunResult } from './hookRunner';
import { hookWorkspaceService } from './HookWorkspaceService';
import { getHookRegistry } from './HookRegistryService';
import {
  resolveHookInvocations,
  type HookInvocationInput,
  type ResolvedHookInvocation,
} from './resolveHookInvocation';

export interface RunHookOnDemandInput extends HookInvocationInput {
  /** Disabled hooks require an explicit override for an on-demand run. */
  force?: boolean;
}

interface OnDemandHookRun {
  nodeId: string | null;
  eventName: string;
  event: Record<string, unknown>;
  result: HookRunResult;
}

export interface RunHookOnDemandResult {
  hookName: string;
  runs: OnDemandHookRun[];
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function suggestions(query: string, names: string[]): string[] {
  const normalized = query.toLowerCase();
  return [...new Set(names)]
    .map((name) => ({
      name,
      distance: editDistance(normalized, name.toLowerCase()),
      contains: name.toLowerCase().includes(normalized) || normalized.includes(name.toLowerCase()),
    }))
    .sort(
      (a, b) =>
        Number(b.contains) - Number(a.contains) ||
        a.distance - b.distance ||
        a.name.localeCompare(b.name)
    )
    .slice(0, 3)
    .map(({ name }) => name);
}

async function resolveRegistration(
  hookIdOrName: string
): Promise<{ name: string; registration: HookRegistrationRow | null }> {
  const registry = getHookRegistry();
  const rows = await registry.listRegistrations();
  const row = rows.find(
    (candidate) => candidate.name === hookIdOrName || candidate.id === hookIdOrName
  );
  if (row) return { name: row.name, registration: row };

  if (hookWorkspaceService.exists(hookIdOrName)) {
    return { name: hookIdOrName, registration: null };
  }

  const names = [
    ...rows.map((candidate) => candidate.name),
    ...hookWorkspaceService.listAll().map((hook) => hook.hookName),
  ];
  const near = suggestions(hookIdOrName, names);
  throw new Error(
    `Hook not found: ${hookIdOrName}.${near.length > 0 ? ` Did you mean: ${near.join(', ')}?` : ' No hooks are registered.'}`
  );
}

/**
 * Canonical on-demand hook execution path shared by the REST test console and
 * the hook(op:run) builtin. It resolves real entity ids through
 * resolveHookInvocations and executes through HookRegistryService.runForTest;
 * callers must not create a parallel synthetic-payload runner.
 */
export async function runHookOnDemand(
  hookIdOrName: string,
  input: RunHookOnDemandInput,
  options: {
    allowDisabled?: boolean;
    contextAgentId?: string;
    /** Depth and hook chain of the caller; default to the ambient run context. */
    chainDepth?: number;
    hookChain?: readonly string[];
  } = {}
): Promise<RunHookOnDemandResult> {
  const requested = hookIdOrName.trim();
  if (!requested) throw new Error('hook_id_or_name is required');
  if (input.event && (typeof input.event !== 'object' || Array.isArray(input.event))) {
    throw new Error('event must be an object');
  }

  const { name: hookName, registration } = await resolveRegistration(requested);
  if (registration && !registration.enabled && !options.allowDisabled && input.force !== true) {
    throw new Error(`Hook "${hookName}" is disabled. Pass force: true to run it explicitly.`);
  }

  const invocations = await resolveHookInvocations(hookName, input);
  const runs: OnDemandHookRun[] = [];
  for (const invocation of invocations) {
    const result = await getHookRegistry().runForTest({
      hookName,
      eventName: invocation.eventName,
      event: invocation.event,
      context: {
        ...withAgentContext(invocation, options.contextAgentId),
        ...(options.chainDepth === undefined ? {} : { chainDepth: options.chainDepth }),
        ...(options.hookChain === undefined ? {} : { hookChain: options.hookChain }),
      },
      // The agent asking (none for a person): another agent never runs a hook
      // under the agent it is set to run as (onDemandRunsAs).
      ...(options.contextAgentId ? { callerAgentId: options.contextAgentId } : {}),
    });
    runs.push({
      nodeId: invocation.nodeId,
      eventName: invocation.eventName,
      event: invocation.event,
      result,
    });
  }
  return { hookName, runs };
}

function withAgentContext(
  invocation: ResolvedHookInvocation,
  agentId: string | undefined
): ResolvedHookInvocation['context'] {
  return agentId ? { ...invocation.context, agentId } : invocation.context;
}
