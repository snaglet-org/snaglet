/**
 * guardedTools — the GUARDED tool set and the creation-time confirmation
 * default built from it.
 *
 * "Guarded" = the tools whose individual invocations already get call-time
 * permission checks (GUARDED_TOOL_KINDS — shell/file/SQL/git, shared with the
 * UI rule editor) PLUS every builtin whose definition declares
 * `destructive: true`. Both halves are DERIVED from their single sources of
 * truth (the shared rule grammar and each tool's definition.ts via the
 * registry) — there is deliberately no hand-maintained id list here to drift.
 *
 * NEW agents (UI create route, the create_agent tool, and default seeding —
 * all of which funnel through AgentService) start with a per-tool
 * `toolOverrides[toolId].requiresConfirmation: true` for this set, so a fresh
 * install asks a human before an agent's first shell command, file write, or
 * destructive call. This is data written AT CREATION TIME only: existing agent
 * rows (null/absent overrides) resolve exactly as before, and the existing
 * AgentToolResolver / toolDispatch confirmation machinery consumes the
 * overrides unchanged — no migration, no new resolution surface.
 */

import type { ToolOverride } from '@snaglet/shared/types';
import { GUARDED_TOOL_KINDS } from '@snaglet/shared/utils';
import { toolRegistry } from '../ToolRegistry';
import { logger } from '@server/config/logger';

/**
 * Resolve the guarded tool ids: call-time-guarded kinds ∪ destructive
 * definitions. Sorted for stable persistence/test output.
 *
 * Best-effort on the registry half: agent creation must not fail because tool
 * discovery hiccupped, so a registry error degrades to the (static, shared)
 * guarded kinds instead of throwing.
 */
export async function getGuardedToolIds(): Promise<string[]> {
  const ids = new Set<string>(Object.keys(GUARDED_TOOL_KINDS));
  try {
    await toolRegistry.load();
    for (const [toolId, def] of Object.entries(toolRegistry.getAllDefinitions())) {
      if (def.destructive || (def.destructiveOps?.length ?? 0) > 0) ids.add(toolId);
    }
  } catch (err) {
    logger.warn('[guardedTools] registry load failed — guarded set degrades to static kinds', err);
  }
  return [...ids].sort();
}

/**
 * Apply the creation-time guarded confirmation default to a (possibly absent)
 * toolOverrides map. For every guarded tool id with no EXPLICIT
 * `requiresConfirmation` already present, set it to `true`; explicit caller
 * values (true or false) and per-tool `settings` are preserved untouched.
 *
 * Returns a NEW map — inputs are never mutated. Called only from agent
 * creation/seeding paths; never from update paths.
 */
export async function withGuardedConfirmationDefaults(
  existing: Record<string, unknown> | null | undefined
): Promise<Record<string, ToolOverride>> {
  const out: Record<string, ToolOverride> = {};
  if (existing && typeof existing === 'object') {
    for (const [toolId, override] of Object.entries(existing)) {
      out[toolId] = { ...(override as ToolOverride) };
    }
  }
  for (const toolId of await getGuardedToolIds()) {
    if (out[toolId]?.requiresConfirmation === undefined) {
      out[toolId] = { ...out[toolId], requiresConfirmation: true };
    }
  }
  return out;
}
