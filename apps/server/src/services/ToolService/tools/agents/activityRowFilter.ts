import { TOOL_ALIASES, resolveToolId } from '@snaglet/shared/utils';
import type { ActivityRowFilter } from '@snaglet/db';

const ACTIVITY_ACTION_TYPES = ['tool_call', 'thinking'] as const;

/**
 * Every stored name a tool filter should match: the input, its canonical id,
 * and every alias id that resolves to it. Log rows keep whatever name the
 * tool was called by, so an `exec_command` row must match `shell` and vice
 * versa.
 */
export function activityToolNames(tool: string): string[] {
  const input = tool.trim();
  const canonical = resolveToolId(input).id;
  const names = new Set([input, canonical]);
  for (const [oldId, spec] of Object.entries(TOOL_ALIASES)) {
    if (spec.id === canonical) names.add(oldId);
  }
  return [...names];
}

/** Read `action_type` and `tool` params into a SQL-side row filter. */
export function resolveActivityRowFilter(params: Record<string, unknown>): ActivityRowFilter {
  const actionType =
    typeof params.action_type === 'string' && params.action_type.trim()
      ? params.action_type.trim()
      : undefined;
  const tool = typeof params.tool === 'string' && params.tool.trim() ? params.tool : undefined;
  return {
    ...(actionType ? { actionType } : {}),
    ...(tool ? { tools: activityToolNames(tool) } : {}),
  };
}

/** One-line hint for a filtered query that matched nothing. Undefined when no filter was set. */
export function emptyFilterHint(params: Record<string, unknown>): string | undefined {
  if (!params.action_type && !params.tool) return undefined;
  return `No entries matched. action_type is ${ACTIVITY_ACTION_TYPES.join('|')}; filter by tool name with tool.`;
}
