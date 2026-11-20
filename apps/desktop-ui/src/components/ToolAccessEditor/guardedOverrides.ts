/**
 * guardedOverrides — pure helpers for the Guarded indicator / Trusted-mode
 * action in ToolAccessEditor.
 *
 * New agents are created server-side with per-tool
 * `toolOverrides[toolId].requiresConfirmation: true` for the guarded set
 * (shell/file/SQL/git + destructive builtins — see the server's
 * ToolService/lib/guardedTools). The UI reads that state straight from the
 * agent's `toolOverrides` (data-driven — no duplicated tool list to drift)
 * and "Trusted mode" clears exactly those confirmation flags.
 */

import type { ToolOverride } from '@snaglet/shared/types';

function entries(
  overrides: Record<string, unknown> | null | undefined
): Array<[string, ToolOverride]> {
  if (!overrides || typeof overrides !== 'object') return [];
  return Object.entries(overrides as Record<string, ToolOverride>);
}

/** Number of tools this agent asks a human about before running. */
export function countConfirmingTools(
  overrides: Record<string, unknown> | null | undefined
): number {
  return entries(overrides).filter(([, o]) => o?.requiresConfirmation === true).length;
}

/**
 * The Trusted-mode clear: strip every `requiresConfirmation: true` flag while
 * preserving per-tool `settings` and explicit `false` values. Entries left
 * empty are dropped; an empty result returns null so the agent's column goes
 * back to the pre-guarded shape (absent → resolver default, false).
 */
export function clearConfirmationOverrides(
  overrides: Record<string, unknown> | null | undefined
): Record<string, ToolOverride> | null {
  const out: Record<string, ToolOverride> = {};
  for (const [toolId, override] of entries(overrides)) {
    if (override?.requiresConfirmation !== true) {
      out[toolId] = override;
      continue;
    }
    const { requiresConfirmation: _cleared, ...rest } = override;
    if (Object.keys(rest).length > 0) out[toolId] = rest;
  }
  return Object.keys(out).length > 0 ? out : null;
}
