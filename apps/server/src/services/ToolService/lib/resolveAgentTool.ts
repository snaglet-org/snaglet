import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';
import { resolveToolId, toSnakeCase, toolIdsEquivalent } from '@snaglet/shared/utils';

/**
 * Resolve the same id/name/definition-alias surface used by chat dispatch,
 * including permanent catalog aliases. An exact row under an alias id wins
 * while it exists; otherwise the canonical tool wins.
 */
export function findResolvedAgentTool(
  tools: readonly ResolvedAgentTool[],
  lookup: string
): ResolvedAgentTool | undefined {
  const normalized = toSnakeCase(lookup);
  const lower = lookup.toLowerCase();
  const direct = tools.find(
    ({ tool }) =>
      tool.id === lookup ||
      tool.id === normalized ||
      tool.name === lookup ||
      tool.name.toLowerCase() === lower ||
      (tool.aliases ?? []).some(
        (alias: string) => alias === lookup || alias.toLowerCase() === lower
      )
  );
  if (direct) return direct;

  const canonical = resolveToolId(normalized).id;
  return tools.find(({ tool }) => toolIdsEquivalent(tool.id, canonical));
}
