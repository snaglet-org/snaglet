/**
 * Search by meaning is on by default for custom tables up to
 * {@link SEMANTIC_ROW_CAP} rows. A table is in one of three states:
 *
 * - on: it has a `table_semantic_search` row. Every new table gets one when it
 *   is created (`buildCustomTable`), and a person can turn any table on.
 * - turned off by a person: no row, and its id is in the
 *   `search.table_semantic_off` setting. The default never turns it on again.
 * - not decided: neither, which is every table made before the default.
 *
 * {@link enableExistingTablesOnce} applies the default to the tables not
 * decided yet, once per install: on up to the cap; a bigger table stays off
 * until a person turns it on with `confirm` (TableSemanticService). Success
 * records `search.table_semantic_default_on`, so later boots skip it; a run
 * that fails records nothing and is retried next boot (tables it already
 * turned on are decided by then, and an explicit off is respected either way).
 *
 * This module only writes settings. The vectors are built afterward by the
 * embedding worker's sweep (when automatic local intelligence is on) or the
 * Embeddings pane's backfill, as for a table a person turned on.
 */
import { getDb } from '@snaglet/db';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import { TableSemantic } from '@snaglet/db/tables/table_semantic';
import { logger } from '@server/config/logger';
import { searchSettings } from '@server/services/settings/categories/search';
import { settingsService } from '@server/services/settings/settingsService';
import { SEMANTIC_ROW_CAP } from './sizeEstimate';

export interface DefaultOnResult {
  /** Tables it turned on. */
  enabled: number;
  /** Tables over the cap, left off until a person turns them on. */
  overCap: number;
  /** Tables a person had turned off, left off. */
  keptOff: number;
}

/**
 * Once per install: turn search by meaning on for every custom table (active
 * or archived) that has no setting, unless a person turned it off or it has
 * more rows than the cap. Returns null when it already ran. Cheap: one
 * catalog query, a bounded row count (at most cap + 1 rows read) and one
 * insert per table not decided yet, and one marker write.
 */
export async function enableExistingTablesOnce(): Promise<DefaultOnResult | null> {
  if (await settingsService.readOptional(searchSettings.tableSemanticDefaultOn)) return null;
  const turnedOff = (await settingsService.readOptional(searchSettings.tableSemanticOff)) ?? {};
  const result: DefaultOnResult = { enabled: 0, overCap: 0, keptOff: 0 };
  for (const table of await TableSemantic.listUnset()) {
    if (turnedOff[table.tableId] !== undefined) {
      result.keptOff += 1;
      continue;
    }
    const { capped } = await TableCatalog.boundedRowCount(table, SEMANTIC_ROW_CAP);
    if (capped) {
      result.overCap += 1;
      continue;
    }
    await TableSemantic.enableIfUnset(table.tableId);
    result.enabled += 1;
  }
  await settingsService.write(searchSettings.tableSemanticDefaultOn, {
    done: new Date().toISOString(),
  });
  logger.info(
    `[table-semantic] search by meaning is on by default: turned on for ${result.enabled} existing ` +
      `table(s) up to ${SEMANTIC_ROW_CAP.toLocaleString('en-US')} rows; ${result.overCap} bigger ` +
      `table(s) stay off until someone turns them on; ${result.keptOff} turned off by a person stay off`
  );
  return result;
}

/**
 * Remember that a person turned search by meaning off for this table, so the
 * default never turns it back on. Entries of tables that no longer exist are
 * dropped in the same write.
 */
export async function recordTurnedOff(tableId: string): Promise<void> {
  const others = Object.keys(
    (await settingsService.readOptional(searchSettings.tableSemanticOff)) ?? {}
  ).filter((id) => id !== tableId);
  const live = new Set(
    others.length
      ? (
          await getDb().query<{ id: string }>(
            'SELECT id FROM public.table_catalog WHERE id = ANY($1::text[])',
            [others]
          )
        ).rows.map((row) => row.id)
      : []
  );
  const patch: Record<string, string | null> = { [tableId]: new Date().toISOString() };
  for (const id of others) if (!live.has(id)) patch[id] = null;
  await settingsService.mergeEntries(searchSettings.tableSemanticOff, patch);
}

/** Forget a person's "off" for this table: it was turned on again. */
export async function clearTurnedOff(tableId: string): Promise<void> {
  await settingsService.mergeEntries(searchSettings.tableSemanticOff, { [tableId]: null });
}
