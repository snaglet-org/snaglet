/**
 * Shared helpers for tool-access permission rules: the allow/deny list entries
 * that may carry a Claude-Code-style specifier, e.g. `shell_exec(git:*)`.
 *
 * Shared so the server permission engine (ToolService/lib/toolPermission) and
 * the UI tool-access editor agree on which tools are guarded, what kind of
 * specifier each accepts, and how an entry parses/formats. Drift here would be a
 * security bug (the UI could mislabel which tools are constrained), so both sides
 * import from this one place.
 */

export type GuardKind = 'command' | 'path' | 'sql';

/**
 * The tools whose individual invocations are authorized at call time, and the
 * kind of specifier each accepts. The server engine adds the runtime argument
 * extractors on top of this.
 */
export const GUARDED_TOOL_KINDS: Record<string, GuardKind> = {
  shell: 'command',
  shell_exec: 'command',
  exec_command: 'command',
  file: 'path',
  file_write: 'path',
  file_edit: 'path',
  apply_patch: 'path',
  database_execute: 'sql',
  database_query: 'sql',
  git: 'command',
};

export function isGuardedTool(toolId: string): boolean {
  return Object.prototype.hasOwnProperty.call(GUARDED_TOOL_KINDS, toolId);
}

export function guardKindFor(toolId: string): GuardKind | null {
  return GUARDED_TOOL_KINDS[toolId] ?? null;
}

export interface ParsedRule {
  toolId: string;
  /** Text inside the parentheses, or null for a bare `toolId` entry. */
  specifier: string | null;
}

/**
 * Parse a list entry into its tool id and optional specifier.
 *   "shell_exec"            → { toolId: 'shell_exec', specifier: null }
 *   "shell_exec(git:*)"     → { toolId: 'shell_exec', specifier: 'git:*' }
 *   "file_write( /a/** )"   → { toolId: 'file_write', specifier: '/a/**' }
 * A malformed entry (open paren, no close) keeps the whole thing as the toolId
 * so it simply won't match anything guarded — fail safe.
 */
export function parseRule(entry: string): ParsedRule {
  const trimmed = entry.trim();
  const open = trimmed.indexOf('(');
  if (open === -1 || !trimmed.endsWith(')')) {
    return { toolId: trimmed, specifier: null };
  }
  const toolId = trimmed.slice(0, open).trim();
  const specifier = trimmed.slice(open + 1, -1).trim();
  return { toolId, specifier: specifier.length > 0 ? specifier : null };
}

/** Render a parsed rule back to its canonical list-entry string. */
export function formatRule(rule: ParsedRule): string {
  return rule.specifier === null ? rule.toolId : `${rule.toolId}(${rule.specifier})`;
}
