/**
 * syncToolCatalog: the one write path that reconciles discovered builtin tools
 * with the `tools` table (boot sync and `sync-internal-tool.ts --all`), built
 * to survive a concurrent stale writer on a shared database. Missing folders
 * are only disabled, never deleted (upsertTool's ON CONFLICT omits `enabled`,
 * so a disabled row survives a stale upsert); counts come from before/after
 * rows; a read-back check fails the sync on any divergence. The discovered set
 * must come from the live folder scan (scripts/lib/tool-metadata.ts), not the
 * per-build static registry, which can lag the tree.
 */

import { Tools, type CreateToolInput, type ToolRow } from '@snaglet/db';
import { getErrorMessage } from '@snaglet/shared/utils';
import type { ToolDefinition } from '@server/services/ToolService/types';
import { assertValidToolId } from './toolName';

/** The subset of the Tools model the sync writes through — injectable for unit tests. */
export interface ToolCatalogStore {
  listAll(): Promise<ToolRow[]>;
  upsertTool(input: CreateToolInput): Promise<ToolRow>;
  setEnabled(id: string, enabled: boolean): Promise<ToolRow | null>;
}

export interface SyncCatalogOptions {
  /**
   * When false, the retire pass is skipped entirely (upserts still run).
   * Callers pass false when they cannot trust the discovered set to be
   * complete — e.g. the registry loaded fewer definitions than there are
   * tool folders. Defaults to true.
   */
  allowRetire?: boolean;
  /** Human-readable reason recorded when allowRetire is false. */
  retireDisallowedReason?: string;
  /** Injectable store for unit tests. Defaults to the real Tools model. */
  store?: ToolCatalogStore;
}

export interface SyncCatalogReport {
  /** Size of the discovered (folder-derived) set. */
  discovered: number;
  /** Ids inserted this run (no row existed before). */
  added: string[];
  /** Ids that already had a row and were re-upserted. */
  updated: string[];
  /** Ids disabled this run (enabled builtin rows with no folder). */
  retired: string[];
  /** True when the retire pass did not run; see retireSkipReason. */
  retireSkipped: boolean;
  retireSkipReason: string | null;
  /** Per-tool write failures. */
  errors: string[];
  /** Read-back verification failures — the DB does not match the intended set. */
  divergence: string[];
  /** errors and divergence are both empty. */
  ok: boolean;
}

/**
 * Map a loaded definition.ts export to the row shape upsertTool takes.
 * Shared by both sync entry points so field defaults cannot drift.
 */
export function toolDefinitionToCreateInput(
  def: ToolDefinition,
  fallbackId?: string
): CreateToolInput {
  return {
    id: def.id ?? fallbackId ?? '',
    name: def.name,
    description: def.description,
    type: def.type,
    categoryPath: def.categoryPath ?? 'uncategorized',
    providerId: def.providerId ?? null,
    tier: def.tier,
    parametersSchema: def.parameters_schema,
    keywords: def.keywords ?? [],
    aliases: def.aliases ?? [],
    source: def.source ?? null,
    sortOrder: def.sort_order ?? 0,
    enabled: true,
  };
}

export async function syncToolCatalog(
  defs: CreateToolInput[],
  options: SyncCatalogOptions = {}
): Promise<SyncCatalogReport> {
  const store = options.store ?? Tools;
  const errors: string[] = [];
  const divergence: string[] = [];

  // Two folders resolving to one id would make the reconciliation ambiguous —
  // fail loudly rather than let the second upsert silently win.
  const defIds = new Set<string>();
  for (const def of defs) {
    if (defIds.has(def.id)) errors.push(`duplicate tool id in discovered set: ${def.id}`);
    defIds.add(def.id);
  }

  // Snapshot before mutating: drives add/update classification, the retire
  // set, and the partial-checkout guard.
  const before = await store.listAll();
  const beforeIds = new Set(before.map((row) => row.id));
  const enabledBuiltinsBefore = before.filter((row) => row.type === 'builtin' && row.enabled);

  const added: string[] = [];
  const updated: string[] = [];
  for (const def of defs) {
    try {
      // A tool id violating the provider function-name grammar would 400 at
      // chat time — fail this tool's sync rather than mint a bad id.
      assertValidToolId(def.id, `tool "${def.id}"`);
      await store.upsertTool(def);
      if (beforeIds.has(def.id)) {
        updated.push(def.id);
      } else {
        added.push(def.id);
      }
    } catch (err) {
      errors.push(`${def.id}: ${getErrorMessage(err)}`);
    }
  }

  // Retire pass: soft only (enabled=false, never DELETE; see module header).
  let retireSkipped = false;
  let retireSkipReason: string | null = null;
  if (options.allowRetire === false) {
    retireSkipped = true;
    retireSkipReason =
      options.retireDisallowedReason ?? 'caller disallowed retire (incomplete load)';
  } else if (errors.length > 0) {
    retireSkipped = true;
    retireSkipReason = `refusing to retire after ${errors.length} upsert error(s)`;
  } else if (enabledBuiltinsBefore.length > 0 && defs.length < enabledBuiltinsBefore.length * 0.5) {
    // A tree that suddenly exposes <50% of the tools the DB has enabled is
    // almost certainly a partial/missing checkout — never mass-retire from it.
    retireSkipped = true;
    retireSkipReason =
      `discovered ${defs.length} tool(s) but DB has ${enabledBuiltinsBefore.length} enabled ` +
      `builtin(s) (<50%) — refusing to retire from what looks like a partial checkout`;
  }

  const retired: string[] = [];
  if (!retireSkipped) {
    for (const row of enabledBuiltinsBefore) {
      if (defIds.has(row.id)) continue;
      try {
        await store.setEnabled(row.id, false);
        retired.push(row.id);
      } catch (err) {
        errors.push(`retire ${row.id}: ${getErrorMessage(err)}`);
      }
    }
  }

  // Read-back verification: re-read and compare.
  try {
    const after = await store.listAll();
    const afterById = new Map(after.map((row) => [row.id, row]));
    const addedSet = new Set(added);
    const retiredSet = new Set(retired);

    for (const def of defs) {
      const row = afterById.get(def.id);
      if (!row) {
        divergence.push(`${def.id}: upserted but no row exists after sync`);
        continue;
      }
      if (addedSet.has(def.id) && !row.enabled) {
        divergence.push(`${def.id}: freshly inserted but reads back disabled`);
      }
    }

    for (const id of retired) {
      const row = afterById.get(id);
      // A row disabled here and then deleted by a concurrent writer is still
      // invisible to agents, so absence is not flagged, only a retire that
      // failed to stick.
      if (row && row.enabled) {
        divergence.push(`${id}: retired this run but reads back enabled`);
      }
    }

    if (!retireSkipped) {
      for (const row of after) {
        if (row.type !== 'builtin' || !row.enabled) continue;
        if (defIds.has(row.id) || retiredSet.has(row.id)) continue;
        divergence.push(`${row.id}: enabled builtin row with no tool folder survived the sync`);
      }
    }
  } catch (err) {
    divergence.push(`verification read-back failed: ${getErrorMessage(err)}`);
  }

  return {
    discovered: defs.length,
    added,
    updated,
    retired,
    retireSkipped,
    retireSkipReason,
    errors,
    divergence,
    ok: errors.length === 0 && divergence.length === 0,
  };
}
