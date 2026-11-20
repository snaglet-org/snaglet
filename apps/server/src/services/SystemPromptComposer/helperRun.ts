/**
 * isHelperRun — true when this turn belongs to a subagent helper.
 *
 * Reads the flag every other helper rule reads (contextAssembly,
 * agentToolPolicy): a helper's agent row has `parentAgentId` set to its
 * orchestrator. It is fixed for the row's life, so blocks may branch on it
 * without busting the cached prefix.
 */
import type { SystemPromptContext } from './types';

export function isHelperRun(ctx: SystemPromptContext): boolean {
  return Boolean(ctx?.agent?.parentAgentId);
}
