import { ALWAYS_AVAILABLE_TOOL_IDS } from '@snaglet/shared/constants';

/**
 * Low-risk platform tools every tool-capable agent needs regardless of its
 * allow/deny-list policy. The set lives in `@snaglet/shared/constants` so the
 * advertised catalog, the call-time guard and the tool-access editor cannot
 * drift apart.
 */
export function isAlwaysAvailableTool(toolId: string): boolean {
  return ALWAYS_AVAILABLE_TOOL_IDS.has(toolId);
}

/**
 * Tools an allow-list agent may use without listing them, and so without the
 * call-time ask: they cannot widen what the agent can do. `subagent` starts
 * helpers that inherit the caller's own permissions. Unlike the set
 * above, a deny list can still remove them.
 */
const ALLOW_LIST_EXEMPT_TOOL_IDS = new Set(['subagent']);

export function isAllowListExemptTool(toolId: string): boolean {
  return ALLOW_LIST_EXEMPT_TOOL_IDS.has(toolId);
}
