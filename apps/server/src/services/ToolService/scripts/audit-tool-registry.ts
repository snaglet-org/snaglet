/**
 * Read-only registry validation for CI and local development.
 *
 * Validates two independent things per tool: the `definition.ts` metadata
 * AND that `tool.ts`/`tool.js` actually *imports*. Reading tool.ts as text
 * (loadToolDefinition's toolSource field) says nothing about whether it
 * loads: a handler that fails to import (syntax error, throwing top-level
 * code, a broken relative import) would pass here while registry-source.ts's
 * runtime loader silently skipped it. `loadToolHandler` in ./lib/tool-metadata
 * is the same dynamic-import mechanism the runtime uses, reused here so a
 * "0 failures" audit result means every handler loads for real, not just that
 * its metadata parses.
 */
import path from 'path';
import { pathToFileURL } from 'url';
import {
  listToolFolders,
  loadToolDefinition,
  loadToolHandler,
  folderNameToToolId,
  type ToolFolderEntry,
} from './lib/tool-metadata';
import { getErrorMessage, TOOL_ALIASES, TOOL_OP_PARAM } from '@snaglet/shared/utils';

interface AuditIssue {
  kind:
    | 'failed'
    | 'handler_failed'
    | 'duplicate_id'
    | 'definition_id_mismatch'
    | 'dangling_alias'
    | 'invalid_category'
    | 'invalid_provider'
    | 'invalid_execution_metadata';
  path: string;
  toolId: string;
  reason: string;
}

// Notion + Browser/Playwright moved to live MCP (their tool wrappers were
// deleted); only native-builtin integration providers remain valid here.
const BUILTIN_INTEGRATION_PROVIDER_IDS = new Set(['github', 'google-workspace']);

// Execution metadata (ToolExecutionMetadata in @snaglet/shared/types) is loaded via
// tsx with types stripped, so a typo'd enum value in a definition.ts would
// otherwise flow silently into the registry and break the panel's declarative
// act-as/confirm behavior. Validate values here, same as the provider check.
const CONTEXT_REQUIREMENTS = new Set(['agent-required', 'agent-optional', 'none']);

async function auditEntries(entries: ToolFolderEntry[]): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const ids = new Map<string, string>();
  for (const entry of entries) {
    if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(entry.categoryPath)) {
      issues.push({
        kind: 'invalid_category',
        path: entry.relativePath,
        toolId: entry.toolId,
        reason: `Invalid category path "${entry.categoryPath}"`,
      });
    }
    // Real dynamic import of tool.ts/tool.js — independent of the definition
    // check below, since a tool can have valid metadata but a broken handler
    // (or vice versa). Reports rather than throws so one bad handler doesn't
    // abort the audit of the other ~175 tools.
    try {
      await loadToolHandler(entry);
    } catch (err) {
      issues.push({
        kind: 'handler_failed',
        path: entry.relativePath,
        toolId: entry.toolId,
        reason: getErrorMessage(err),
      });
    }

    try {
      const loaded = await loadToolDefinition(entry);
      if (
        loaded.definition.providerId &&
        !BUILTIN_INTEGRATION_PROVIDER_IDS.has(loaded.definition.providerId)
      ) {
        issues.push({
          kind: 'invalid_provider',
          path: entry.relativePath,
          toolId: loaded.definition.id,
          reason: `Unknown integration provider "${loaded.definition.providerId}"`,
        });
      }
      const { contextRequirement, destructive, destructiveOps, dispatchOnly } =
        loaded.definition as {
          contextRequirement?: unknown;
          destructive?: unknown;
          destructiveOps?: unknown;
          dispatchOnly?: unknown;
        };
      issues.push(
        ...auditDestructiveOps(
          entry.relativePath,
          loaded.definition.id,
          loaded.definition.parameters_schema,
          destructive,
          destructiveOps
        )
      );
      if (
        contextRequirement !== undefined &&
        !CONTEXT_REQUIREMENTS.has(String(contextRequirement))
      ) {
        issues.push({
          kind: 'invalid_execution_metadata',
          path: entry.relativePath,
          toolId: loaded.definition.id,
          reason: `Unknown contextRequirement "${String(contextRequirement)}" (expected ${[...CONTEXT_REQUIREMENTS].join(' | ')})`,
        });
      }
      for (const [field, value] of [
        ['destructive', destructive],
        ['dispatchOnly', dispatchOnly],
      ] as const) {
        if (value !== undefined && typeof value !== 'boolean') {
          issues.push({
            kind: 'invalid_execution_metadata',
            path: entry.relativePath,
            toolId: loaded.definition.id,
            reason: `${field} must be a boolean when declared (got ${typeof value})`,
          });
        }
      }
      const previous = ids.get(loaded.definition.id);
      if (loaded.definition.id !== entry.toolId) {
        issues.push({
          kind: 'definition_id_mismatch',
          path: entry.relativePath,
          toolId: loaded.definition.id,
          reason:
            `Folder registers handler id "${entry.toolId}" but definition declares ` +
            `"${loaded.definition.id}"`,
        });
      }
      if (previous) {
        issues.push({
          kind: 'duplicate_id',
          path: entry.relativePath,
          toolId: loaded.definition.id,
          reason: `Also defined at ${previous}`,
        });
      } else {
        ids.set(loaded.definition.id, entry.relativePath);
      }
    } catch (err) {
      issues.push({
        kind: 'failed',
        path: entry.relativePath,
        toolId: entry.toolId,
        reason: getErrorMessage(err),
      });
    }
  }

  return issues;
}

/**
 * Strict per-op destructiveness: an `op`-enum tool declares
 * `destructiveOps` instead of a whole-tool `destructive: true`, and every
 * listed op must be in its enum.
 */
function auditDestructiveOps(
  path: string,
  toolId: string,
  schema: unknown,
  destructive: unknown,
  destructiveOps: unknown
): AuditIssue[] {
  const issue = (reason: string): AuditIssue => ({
    kind: 'invalid_execution_metadata',
    path,
    toolId,
    reason,
  });
  const opEnum = (schema as { properties?: Record<string, { enum?: unknown }> } | undefined)
    ?.properties?.[TOOL_OP_PARAM]?.enum;
  const ops = Array.isArray(opEnum) ? opEnum.filter((v): v is string => typeof v === 'string') : [];
  const issues: AuditIssue[] = [];
  if (destructiveOps !== undefined) {
    if (!Array.isArray(destructiveOps) || destructiveOps.some((op) => typeof op !== 'string')) {
      return [issue('destructiveOps must be an array of op names')];
    }
    if (ops.length === 0) {
      issues.push(issue('destructiveOps declared on a tool without an `op` enum'));
    }
    for (const op of destructiveOps as string[]) {
      if (ops.length > 0 && !ops.includes(op)) {
        issues.push(issue(`destructiveOps lists "${op}", which is not in the op enum`));
      }
    }
  }
  if (destructive === true && ops.length > 0) {
    issues.push(
      issue('op-enum tool sets destructive: true; declare destructiveOps for the ops instead')
    );
  }
  return issues;
}

function auditAliasTargets(registeredIds: ReadonlySet<string>): AuditIssue[] {
  const issues: AuditIssue[] = [];
  for (const [oldId, alias] of Object.entries(TOOL_ALIASES)) {
    if (alias.removed || registeredIds.has(alias.id)) continue;
    issues.push({
      kind: 'dangling_alias',
      path: 'packages/shared/utils/toolAliases.ts',
      toolId: oldId,
      reason: `Alias target "${alias.id}" is not a registered builtin definition`,
    });
  }
  return issues;
}

function formatHuman(issues: AuditIssue[], discoveredCount: number): string {
  if (issues.length === 0) {
    return `tool-registry clean - ${discoveredCount}/${discoveredCount} tools loaded, 0 failures.`;
  }
  return [
    `tool-registry audit found ${issues.length} issue(s):`,
    ...issues.map((issue) => `  ${issue.kind} ${issue.path}: ${issue.reason}`),
  ].join('\n');
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const entries = listToolFolders();
  const issues = await auditEntries(entries);
  issues.push(...auditAliasTargets(new Set(entries.map(({ toolId }) => toolId))));
  if (args.has('--json')) {
    console.log(JSON.stringify({ discovered: entries.length, issues }, null, 2));
  } else {
    console.log(formatHuman(issues, entries.length));
  }
  if (args.has('--strict') && issues.length > 0) process.exit(1);
}

const isDirectEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectEntry) {
  main().catch((err) => {
    console.error('audit-tool-registry failed:', err);
    process.exit(2);
  });
}

export { auditAliasTargets, auditDestructiveOps, auditEntries, formatHuman, folderNameToToolId };
