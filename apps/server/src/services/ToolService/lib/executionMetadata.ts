/**
 * executionMetadata — read static ToolExecutionMetadata for a tool id.
 *
 * The metadata lives only in each builtin's definition.ts (via ToolDefinition)
 * and is decorated onto API payloads at read time rather than persisted into
 * the `tools` DB rows. That keeps definition.ts the single source of truth
 * (no stale DB copies, no schema migration) at the cost of a registry lookup —
 * `toolRegistry.load()` is memoized and completes at boot, so the await below
 * is a no-op on every request after startup.
 *
 * Non-builtin tools (MCP, external/user-authored) have no definition.ts and
 * yield {} — the panel treats them as standalone, non-destructive, runnable,
 * which matches today's behavior for those tool types.
 */
import { toolRegistry } from '../ToolRegistry';
import type { ToolExecutionMetadata } from '@snaglet/shared/types';

export async function getToolExecutionMetadata(toolId: string): Promise<ToolExecutionMetadata> {
  await toolRegistry.load();
  const def = toolRegistry.getDefinition(toolId);
  if (!def) return {};
  const meta: ToolExecutionMetadata = {};
  // Only copy declared fields — unmarked tools stay clean instead of every
  // API row growing three undefined-ish keys.
  if (def.contextRequirement !== undefined) meta.contextRequirement = def.contextRequirement;
  if (def.destructive) meta.destructive = true;
  if (def.destructiveOps?.length) meta.destructiveOps = [...def.destructiveOps];
  if (def.dispatchOnly) meta.dispatchOnly = true;
  return meta;
}

/** Spread a row + its execution metadata (list/describe route decoration). */
export async function decorateToolExecutionMetadata<T extends { id: string }>(
  row: T
): Promise<T & ToolExecutionMetadata> {
  return { ...row, ...(await getToolExecutionMetadata(row.id)) };
}
