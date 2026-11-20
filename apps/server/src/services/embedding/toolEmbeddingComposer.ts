/**
 * Tool embedding text composer + FS map.
 *
 * Composes the embedding-input string for a single tool, used by:
 *   - the backfill / dryrun scripts (one-shot, full-table)
 *   - the EmbeddingWorker (periodic, embed-if-missing)
 *
 * Source of truth: DB row (richer than FS loader — has aliases, covers MCP).
 * Optional enrichment: TOOL.md body read from the filesystem when present
 * (builtin tools only — MCP tools have no FS entry).
 *
 * Output format: newline-delimited "fact sheet", no prose wrapping.
 *
 * Policy (locked upthread):
 *   - keywords empty/undefined  → omit line
 *   - aliases empty/undefined   → omit line
 *   - category path empty       → omit line + log warning (observability)
 *   - param with no description → omit param
 *   - zero documented params    → omit `parameters:` header
 *   - id, name, description     → always present (missing description = registry bug)
 *   - parameters_schema flatten → top-level properties only, depth=1, skip $defs/$ref
 *   - param overflow            → cap 20, append `... (N more omitted)`
 *   - TOOL.md body              → verbatim under `documentation:` up to TOOL_MD_MAX_CHARS
 *   - TOOL.md > TOOL_MD_MAX_CHARS → truncated with marker + `toolmd_oversized` warning
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';

export interface ToolDbRow {
  id: string;
  name: string;
  description: string | null;
  category_path: string;
  type: string; // 'builtin' | 'mcp' | 'external'
  keywords: string[] | null;
  aliases: string[] | null;
  parameters_schema: unknown;
}

export interface FsEntry {
  /** Absolute path to the tool's directory (containing tool.ts and optionally TOOL.md). */
  absPath: string;
}

type ComposerWarningCode =
  | 'empty_category_path'
  | 'missing_description'
  | 'toolmd_oversized'
  | 'toolmd_unreadable'
  | 'malformed_schema';

interface ComposerWarning {
  toolId: string;
  code: ComposerWarningCode;
  detail?: string;
}

export interface ComposeOptions {
  /** Optional warn sink; defaults to the server logger. */
  warn?: (msg: string) => void;
}

export interface ComposeResult {
  text: string;
  charCount: number;
  estTokens: number;
  hasToolMd: boolean;
  toolMdChars: number;
  warnings: ComposerWarning[];
}

const MAX_PARAMS = 20;
// ≈ 6000 tokens at the 4:1 char-to-token estimate. Anything over this gets
// truncated; the cap exists so a pathological TOOL.md can't dominate the
// embedding payload or overflow the model's input window.
const TOOL_MD_MAX_CHARS = 24_000;

/** Absolute path to the builtin tools directory. Resolved from process.cwd(). */
const TOOLS_DIR = path.resolve(process.cwd(), 'apps/server/src/services/ToolService/tools');

/**
 * Walk the builtin tools directory and build a map from tool id → FsEntry.
 * Used by callers that want to enrich the composer payload with TOOL.md.
 * MCP/external tools have no FS entry and won't appear in the map.
 */
export function buildToolFsEntryMap(toolsDir: string = TOOLS_DIR): Map<string, FsEntry> {
  const map = new Map<string, FsEntry>();
  if (!fs.existsSync(toolsDir)) return map;

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const hasToolTs = entries.some((e) => e.isFile() && e.name === 'tool.ts');
    if (hasToolTs) {
      const folderName = path.basename(dir);
      const toolId = folderName.replace(/-/g, '_');
      map.set(toolId, { absPath: dir });
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
    }
  }
  walk(toolsDir);
  return map;
}

export function composeToolEmbeddingText(
  row: ToolDbRow,
  fsEntry?: FsEntry,
  opts: ComposeOptions = {}
): ComposeResult {
  const warn = opts.warn ?? ((m) => logger.warn(m));
  const warnings: ComposerWarning[] = [];
  const lines: string[] = [];

  const pushWarn = (code: ComposerWarningCode, detail?: string) => {
    warnings.push(
      detail !== undefined ? { toolId: row.id, code, detail } : { toolId: row.id, code }
    );
    warn(`[composer] tool '${row.id}': ${code}${detail ? ` (${detail})` : ''}`);
  };

  // Lead with description so the embedding's front-loaded attention budget
  // weighs semantics over identifier tokens. If `name: <id>` led the payload
  // it would bias-pull hits toward tools whose id literal-matches query
  // tokens (e.g. "embed text into vector" → semantic_file_search beats workspace_search
  // because `text` is in the id). Description is the most expressive,
  // semantic field — keep it first.
  if (row.description && row.description.trim()) {
    lines.push(`description: ${row.description.trim()}`);
  } else {
    pushWarn('missing_description');
  }

  // Identifier lines — present but de-prioritized by position.
  lines.push(`name: ${row.id}`);
  lines.push(`display: ${row.name}`);

  // category path — log if empty, omit line
  if (row.category_path && row.category_path.trim()) {
    lines.push(`category: ${row.category_path}`);
  } else {
    pushWarn('empty_category_path');
  }

  // keywords — omit if empty
  if (row.keywords && row.keywords.length > 0) {
    lines.push(`keywords: ${row.keywords.join(', ')}`);
  }

  // aliases — omit if empty
  if (row.aliases && row.aliases.length > 0) {
    lines.push(`aliases: ${row.aliases.join(', ')}`);
  }

  // parameters — flatten top-level only, skip $defs/$ref, depth=1, 20-cap
  const flatten = flattenParameters(row.parameters_schema);
  if (flatten.malformed) {
    pushWarn('malformed_schema');
  }
  const paramLines = flatten.lines;
  if (paramLines.length > 0) {
    lines.push('parameters:');
    const shown = paramLines.slice(0, MAX_PARAMS);
    for (const p of shown) lines.push(`  ${p}`);
    if (paramLines.length > MAX_PARAMS) {
      lines.push(`  ... (${paramLines.length - MAX_PARAMS} more omitted)`);
    }
  }

  // TOOL.md — read from FS if entry provided
  let hasToolMd = false;
  let toolMdChars = 0;
  if (fsEntry?.absPath) {
    const docsPath = path.join(fsEntry.absPath, 'TOOL.md');
    if (fs.existsSync(docsPath)) {
      try {
        const body = fs.readFileSync(docsPath, 'utf-8').trim();
        if (body) {
          hasToolMd = true;
          toolMdChars = body.length;
          let embedBody = body;
          if (body.length > TOOL_MD_MAX_CHARS) {
            const omitted = body.length - TOOL_MD_MAX_CHARS;
            embedBody =
              body.slice(0, TOOL_MD_MAX_CHARS) + `\n\n[… ${omitted} more chars truncated]`;
            pushWarn('toolmd_oversized', `${body.length} → truncated to ${TOOL_MD_MAX_CHARS}`);
          }
          lines.push('documentation:');
          lines.push(embedBody);
        }
      } catch (e) {
        pushWarn('toolmd_unreadable', getErrorMessage(e));
      }
    }
  }

  const text = lines.join('\n');
  return {
    text,
    charCount: text.length,
    estTokens: Math.ceil(text.length / 4),
    hasToolMd,
    toolMdChars,
    warnings,
  };
}

interface FlattenResult {
  lines: string[];
  /** True when schema exists but is shaped unexpectedly (not an object, or properties not an object). */
  malformed: boolean;
}

function flattenParameters(schema: unknown): FlattenResult {
  // Missing schema is normal (e.g. zero-arg tools) — not malformed.
  if (schema === null || schema === undefined) return { lines: [], malformed: false };
  if (typeof schema !== 'object') return { lines: [], malformed: true };

  const s = schema as Record<string, unknown>;
  const props = s.properties;
  // No `properties` key is normal for non-object schemas; only malformed if it exists but isn't an object.
  if (props === undefined) return { lines: [], malformed: false };
  if (!props || typeof props !== 'object') return { lines: [], malformed: true };

  const lines: string[] = [];
  for (const [name, def] of Object.entries(props as Record<string, unknown>)) {
    if (name.startsWith('$')) continue; // $defs, $ref, etc.
    if (!def || typeof def !== 'object') continue;
    const d = def as Record<string, unknown>;
    const desc = typeof d.description === 'string' ? d.description.trim() : '';
    if (!desc) continue;
    lines.push(`${name}: ${desc}`);
  }
  return { lines, malformed: false };
}
