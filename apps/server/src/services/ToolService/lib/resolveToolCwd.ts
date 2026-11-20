/**
 * resolveToolCwd — determine the working directory for a single tool call.
 *
 * Priority:
 *   1. Explicit `cwd` / `path` from the agent's tool-call input (agent chose a specific dir)
 *   2. `context.cwd` from the resolved agent working directory (project / env / default)
 *   3. `process.cwd()` (ultimate fallback — should rarely reach this)
 */

import path from 'path';
import type { ToolHandlerContext } from '../types';

/**
 * Resolve the working directory for a tool call.
 *
 * @param inputCwd — the `cwd` (or `path`) value from the agent's tool-call input, if any.
 *                    Pass `undefined` or empty string when the agent did not specify one.
 * @param context  — the ToolHandlerContext for this execution (carries the resolved agent cwd).
 * @returns absolute path to use as cwd.
 */
export function resolveToolCwd(
  inputCwd: string | undefined | null,
  context?: ToolHandlerContext
): string {
  const explicit = typeof inputCwd === 'string' && inputCwd.length > 0 ? inputCwd : undefined;
  const base = explicit ?? context?.cwd ?? process.cwd();
  return path.resolve(base);
}
