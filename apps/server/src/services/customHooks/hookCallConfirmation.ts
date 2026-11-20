/**
 * hookCallConfirmation — a hook's own tool call that would ask a person first.
 *
 * Hook code calls tools through `/api/tools/execute` with nobody to ask. The
 * access rules are already enforced there (an `ask` verdict is refused), but a
 * tool or op the agent has set to ask first (a guarded agent's `hook`
 * update/enable, a per-tool or per-op "ask first" override) passes them. Such
 * a call is skipped, as an unattended run skips it under the default `skip`
 * policy (unattendedGate.ts): the hook gets a tool error and carries on. This
 * covers every hook run, the ones set to run as an agent included, so running
 * as an agent never runs that agent's ask-first calls unprompted.
 */

import type { ToolRow } from '@snaglet/db/tables/tools';
import type { ToolOverride } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import {
  unattendedSkipMessage,
  unattendedToolLabel,
} from '@server/services/SocketService/handlers/chatPhases/unattendedGate';

/**
 * Whether `agentId`'s call to `tool` with `input` would ask a person first:
 * the agent's resolved confirmation for the tool, per op for merged tools
 * (confirmationForCall), with the hook run's thread's per-agent overrides on
 * top (a thread can set a tool to ask first), as chat resolves it. A failed
 * lookup counts as asking (fail closed).
 */
export async function hookCallAsksFirst(
  agentId: string,
  tool: Pick<ToolRow, 'id'>,
  input: Record<string, unknown>,
  threadId?: string
): Promise<boolean> {
  try {
    const { confirmationForCall, resolveAgentToolsForExecution } =
      await import('@server/services/AgentToolResolver');
    let threadOverrides: Record<string, ToolOverride> | undefined;
    if (threadId) {
      const { resolveThreadRuntimeConfig } = await import('@server/services/ConfigResolverService');
      threadOverrides = (await resolveThreadRuntimeConfig(threadId))?.agentOverrides.get(
        agentId
      )?.toolOverrides;
    }
    const resolved = (
      await resolveAgentToolsForExecution(agentId, threadOverrides ? { threadOverrides } : {})
    ).find((candidate) => candidate.tool.id === tool.id);
    return resolved ? confirmationForCall(resolved, input) : false;
  } catch (err) {
    logger.warn(
      `[hooks] could not resolve whether ${tool.id} asks first for ${agentId}; skipping it: ${getErrorMessage(err)}`
    );
    return true;
  }
}

/** The tool result a skipped hook call returns: it did not run, and why. */
export function hookSkippedCallResult(
  toolId: string,
  input: Record<string, unknown>
): { success: false; output: string; error: string; durationMs: number } {
  return {
    success: false,
    output: '',
    error: unattendedSkipMessage(unattendedToolLabel(toolId, input), 'policy'),
    durationMs: 0,
  };
}
