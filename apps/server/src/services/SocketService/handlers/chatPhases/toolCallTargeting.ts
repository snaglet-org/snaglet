/**
 * Shared tool-call identity + targeting.
 *
 * ONE source of truth for "what does this tool call touch", used by both the
 * in-run repeat guard (repeatCallGuard.ts) and the retention/dedup condenser
 * (chatHelpers.condenseProcessedToolResults). Keeping them consistent is what
 * makes the two features compose safely:
 *
 *   - identity hash → the map key both features group repeats/copies by.
 *   - role (read / mutation / other) → whether a call's result is cacheable and
 *     whether it invalidates earlier reads.
 *   - subject → the concrete target (a file path, a doc id) a read reads or a
 *     mutation writes, so a write can invalidate cached reads of the same
 *     target (and only that target).
 *   - fullCoverage → whether a read is whole-target (no line range / filter), so
 *     partial-vs-full supersession is correct: a full read supersedes narrower
 *     earlier reads, but a narrow read never supersedes a full one.
 *
 * Classification is intentionally conservative: unknown tools are `other` with
 * no subject (deduped only on an exact byte-identical input), and exec-family
 * tools invalidate ALL cached reads because their filesystem effects are opaque.
 */

import { createHash } from 'crypto';
import { isRecord } from '@snaglet/shared/utils';

type ToolRole = 'read' | 'mutation' | 'other';

/** What a mutation invalidates: everything, or one concrete subject. */
export type MutationScope = { scope: 'all' } | { scope: 'subject'; subject: string };

export interface ToolCallClassification {
  role: ToolRole;
  /** Concrete target read/written, when determinable (file path, doc id). */
  subject: string | null;
  /** True when a read covers the whole target (no line range / filter). */
  fullCoverage: boolean;
  /** Present only for mutations — what cached reads it invalidates. */
  mutation: MutationScope | null;
}

/** Stable, order-independent serialization of a tool input for hashing. */
export function canonicalizeInput(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortDeep(obj[k]);
        return acc;
      }, {});
  }
  return value;
}

/** Exact identity for (tool, input) — the map key shared across features. */
export function toolCallHash(toolName: string, input: unknown): string {
  return createHash('sha1')
    .update(`${toolName} ${canonicalizeInput(input)}`)
    .digest('hex');
}

// Exec / working-tree mutators: filesystem effects are opaque, so any of these
// invalidates ALL cached reads (conservative — never serve stale data).
const EXEC_ALL_SCOPE = new Set([
  'shell',
  'exec_command',
  'shell_exec',
  'sandbox_run',
  'write_stdin',
  'apply_patch',
  'git_checkout',
  'git_pull',
  'git_stash',
  'git',
]);

// File mutators — subject is the file path.
const FILE_MUTATION = new Set(['file_write', 'file_edit']);

// Doc mutators — subject is the doc id / path.
const DOC_MUTATION = new Set([
  'edit_doc',
  'delete_doc',
  'restore_snapshot',
  'doc_history',
  'convert_doc_to_container',
]);

// doc(op): get reads; update and delete mutate the doc (create has no prior
// subject to invalidate, the same as create_doc before the merge).
const DOC_MUTATION_OPS = new Set([
  'update',
  'delete',
  'snapshot',
  'list-snapshots',
  'restore',
  'delete-snapshot',
  'convert-to-container',
]);

// Workspace-node mutators — subject is the node id.
const NODE_MUTATION = new Set([
  'workspace_move',
  'move',
  'workspace_rename',
  'rename',
  'workspace_archive_node',
  'archive_node',
  'workspace_restore_node',
  'restore_node',
]);
// node(op): get and tree read; move/rename/archive/restore mutate the node.
const NODE_MUTATION_OPS = new Set(['move', 'rename', 'archive', 'restore']);

// Database reads and writers share one subject, so any write invalidates cached
// reads (a re-read after a table write must never be served stale). Reads are not
// full coverage: different queries never supersede each other.
const DATABASE_SUBJECT = 'database';
const DATABASE_MUTATION = new Set([
  'table_write',
  'table_schema',
  'table_delete',
  'database_execute',
  'database_update',
  'database_delete',
  'database_create',
  'create_view',
]);
const DATABASE_READ = new Set(['table_read', 'database_query', 'database_describe']);
// table(op): read is a database read; write, schema and delete mutate.
const TABLE_MUTATION_OPS = new Set(['write', 'schema', 'delete']);

// change_color_theme: get reads the saved theme; set and reset write it, so a
// get after a change is a fresh read, never the cached pre-change theme.
const THEME_TOOL = 'change_color_theme';
const THEME_SUBJECT = 'appearance.colors';
// workspace_instructions works the same way on the instructions for all agents.
const SETTING_TOOL_SUBJECTS: Readonly<Record<string, string>> = {
  [THEME_TOOL]: THEME_SUBJECT,
  workspace_instructions: 'agent.global_instructions',
};

// Reads whose subject is a file path.
const FILE_READ = new Set(['file_read', 'file_read_image', 'file_info']);
// Reads whose subject is a doc id / path.
const DOC_READ = new Set(['get_doc']);

// Param keys that carry a line-range / filter — their presence means a read is
// not full coverage (so it must not supersede a whole-target read).
const RANGE_KEYS = ['start_line', 'end_line', 'offset', 'limit', 'start', 'end', 'lines', 'range'];

function firstStringKey(input: unknown, keys: string[]): string | null {
  if (!isRecord(input)) return null;
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * file(op) classifies exactly as the tool each op replaced: read/info as file
 * reads, create and update(edits|content) as path-scoped file mutations,
 * update(patch) as apply_patch (all-scope, since a patch can touch any file),
 * list and diff as unscoped others.
 */
function fileOpAsLegacyId(input: unknown): string {
  const op = isRecord(input) && typeof input.op === 'string' ? input.op : '';
  switch (op) {
    case 'read':
      return 'file_read';
    case 'info':
      return 'file_info';
    case 'create':
      return 'file_write';
    case 'update':
      return isRecord(input) && input.patch != null ? 'apply_patch' : 'file_edit';
    default:
      return 'file_other';
  }
}

function filePathSubject(input: unknown): string | null {
  return firstStringKey(input, ['path', 'file_path', 'filepath', 'file']);
}

function docSubject(input: unknown): string | null {
  return firstStringKey(input, ['doc_id', 'id', 'doc_path', 'node_id', 'path']);
}

function hasRange(input: unknown): boolean {
  if (!isRecord(input)) return false;
  return RANGE_KEYS.some((k) => input[k] !== undefined && input[k] !== null);
}

/**
 * Classify a resolved tool call (real tool id + its params, already unwrapped
 * from the `action` gateway).
 */
export function classifyToolCall(toolName: string, input: unknown): ToolCallClassification {
  if (toolName === 'file') return classifyToolCall(fileOpAsLegacyId(input), input);
  if (EXEC_ALL_SCOPE.has(toolName)) {
    return { role: 'mutation', subject: null, fullCoverage: false, mutation: { scope: 'all' } };
  }
  if (FILE_MUTATION.has(toolName)) {
    const subject = filePathSubject(input);
    return {
      role: 'mutation',
      subject,
      fullCoverage: false,
      mutation: subject ? { scope: 'subject', subject } : { scope: 'all' },
    };
  }
  const docOp = toolName === 'doc' && isRecord(input) ? String(input.op) : null;
  if (DOC_MUTATION.has(toolName) || (docOp !== null && DOC_MUTATION_OPS.has(docOp))) {
    const subject = docSubject(input);
    return {
      role: 'mutation',
      subject,
      fullCoverage: false,
      mutation: subject ? { scope: 'subject', subject } : { scope: 'all' },
    };
  }
  if (
    NODE_MUTATION.has(toolName) ||
    (toolName === 'node' && isRecord(input) && NODE_MUTATION_OPS.has(String(input.op)))
  ) {
    const subject = docSubject(input);
    return {
      role: 'mutation',
      subject,
      fullCoverage: false,
      mutation: subject ? { scope: 'subject', subject } : { scope: 'all' },
    };
  }
  const tableOp = toolName === 'table' && isRecord(input) ? String(input.op) : null;
  if (DATABASE_MUTATION.has(toolName) || (tableOp !== null && TABLE_MUTATION_OPS.has(tableOp))) {
    return {
      role: 'mutation',
      subject: DATABASE_SUBJECT,
      fullCoverage: false,
      mutation: { scope: 'subject', subject: DATABASE_SUBJECT },
    };
  }
  if (
    DATABASE_READ.has(toolName) ||
    tableOp === 'read' ||
    tableOp === 'fields' ||
    tableOp === 'query'
  ) {
    return { role: 'read', subject: DATABASE_SUBJECT, fullCoverage: false, mutation: null };
  }
  const settingSubject = SETTING_TOOL_SUBJECTS[toolName];
  if (settingSubject) {
    return isRecord(input) && input.op === 'get'
      ? { role: 'read', subject: settingSubject, fullCoverage: true, mutation: null }
      : {
          role: 'mutation',
          subject: settingSubject,
          fullCoverage: false,
          mutation: { scope: 'subject', subject: settingSubject },
        };
  }
  if (FILE_READ.has(toolName)) {
    const subject = filePathSubject(input);
    return { role: 'read', subject, fullCoverage: !hasRange(input), mutation: null };
  }
  if (DOC_READ.has(toolName) || docOp === 'get') {
    const subject = docSubject(input);
    return { role: 'read', subject, fullCoverage: !hasRange(input), mutation: null };
  }
  // Everything else: cacheable for repeat-suppression, but no known subject —
  // deduped only on an exact byte-identical input, never invalidated by a write
  // to a specific subject (only by an all-scope exec).
  return { role: 'other', subject: null, fullCoverage: true, mutation: null };
}

/**
 * Whether `newer` (a later read) covers `older` (an earlier read of the same
 * subject) closely enough to supersede it. A full-coverage read supersedes any
 * earlier read of its subject; a range read supersedes only a byte-identical
 * earlier read — a narrow read never supersedes a broader one.
 */
export function readSupersedes(
  newer: { hash: string; fullCoverage: boolean },
  older: { hash: string }
): boolean {
  if (newer.hash === older.hash) return true;
  return newer.fullCoverage;
}
