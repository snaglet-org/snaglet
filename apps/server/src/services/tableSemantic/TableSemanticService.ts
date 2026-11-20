/**
 * Vector search over a custom table's rows.
 *
 * On by default for tables up to {@link SEMANTIC_ROW_CAP} rows (new tables at
 * creation, older ones once at boot: see defaultOn.ts); a bigger table is off
 * until a person turns it on with `confirm`, and a person can turn any table
 * off. The cap holds as a table grows: one turned on within it that later
 * passes it is held (what is built stays) until a person confirms. Once on, the embedding worker's sweep builds one vector per row from a
 * short "row card" (see rowCard.ts), re-embedding only a row whose card
 * changed and deleting the vector of a row that is gone; keyword search keeps
 * working the whole time. Turning it off deletes the table's vectors.
 */
import { getDb } from '@snaglet/db';
import {
  TableCatalog,
  CUSTOM_TABLES_SCHEMA,
  type TableCatalogRow,
} from '@snaglet/db/tables/table_catalog';
import { TableFields } from '@snaglet/db/tables/table_fields';
import {
  TableSemantic,
  type SemanticHit,
  type SemanticSettings,
} from '@snaglet/db/tables/table_semantic';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import {
  ErrorCode,
  HTTP_STATUS,
  type SemanticStatus,
  type SemanticTableRow,
} from '@snaglet/shared/types';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';
import {
  resolveEmbeddingProvider,
  type EmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
export type { SemanticStatus };
import {
  completed,
  cursors,
  finishPass,
  heldAtCap,
  passedAt,
  REPASS_AFTER_MS,
  resetTable,
} from './sweepState';
import {
  buildCard,
  cardFields,
  cardHash,
  CARD_CELL_MAX_CHARS,
  isSensitiveFieldName,
} from './rowCard';
import { clearTurnedOff, recordTurnedOff } from './defaultOn';
import { estimateSemanticSize, SEMANTIC_ROW_CAP } from './sizeEstimate';

/** The vector size of `table_entry_embeddings`: Snaglet's one local embedder. */
const VECTOR_DIMENSIONS = 768;
/** Rows read per page by the sweep. */
const SWEEP_PAGE_ROWS = 100;
/** Rows the sweep embeds per tick, across all tables. */
const SWEEP_EMBEDS_PER_TICK = 40;
/** A table's size is counted up to this many rows; past it the estimate says "or more". */
const COUNT_CEILING = 100_000;
/** Manual parent jobs page every enabled table without truncating confirmed tables. */
const SEMANTIC_PAGE_ROWS = 100;

const NAME_RULE_WARNING =
  'Cells are left out of the index by field name only (password, token, api key, card or account number and similar), which is best-effort: a secret in a column with another name is embedded. Do not turn this on for a table that keeps secrets in its text or select cells.';

function badRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

async function customTable(tableId: string): Promise<TableCatalogRow> {
  const row = await TableCatalog.findById(tableId);
  if (!row || row.state === 'deleted')
    throw new AppError(`Table not found: ${tableId}`, ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  if (row.origin !== 'custom')
    throw new AppError(
      `${row.name} is a Snaglet table; only custom tables have entries to index.`,
      ErrorCode.FORBIDDEN,
      HTTP_STATUS.FORBIDDEN
    );
  if (row.state !== 'active')
    throw new AppError(
      `${row.name} is archived. Restore it first.`,
      ErrorCode.CONFLICT,
      HTTP_STATUS.CONFLICT
    );
  return row;
}

function pausedReason(): string | undefined {
  return isAutomaticLocalIntelligenceEnabled()
    ? undefined
    : 'Automatic local intelligence is off (SNAGLET_LOCAL_INTELLIGENCE), so nothing is being built.';
}

/**
 * On, but past the cap without a person's confirmation: turned on (by default
 * or by a person) within the cap, the table has since grown. Building waits
 * for `confirm`; a confirmed table keeps indexing as it grows.
 */
function awaitsConfirm(settings: SemanticSettings | null, rows: number): boolean {
  return settings !== null && settings.confirmedRows === null && rows > SEMANTIC_ROW_CAP;
}

function overCapReason(rows: number, capped: boolean): string {
  const estimate = estimateSemanticSize(rows);
  return (
    `Over ${SEMANTIC_ROW_CAP.toLocaleString('en-US')} rows; turn on anyway to index all ` +
    `${rows.toLocaleString('en-US')}${capped ? '+' : ''} rows (${estimate.label}${capped ? ' or more' : ''}).`
  );
}

/**
 * The build's check before embedding a table's rows: true when the table is
 * past the cap without a confirmation. One capped count (at most cap + 1 rows
 * read), and none for a confirmed table.
 */
async function heldOverCap(table: TableCatalogRow): Promise<boolean> {
  const settings = await TableSemantic.getSettings(table.id);
  if (!settings || settings.confirmedRows !== null) return false;
  return (await TableCatalog.boundedRowCount(table, SEMANTIC_ROW_CAP)).capped;
}

export async function getSemanticStatus(tableId: string): Promise<SemanticStatus> {
  const row = await customTable(tableId);
  const settings = await TableSemantic.getSettings(tableId);
  const { rows, capped } = await TableCatalog.boundedRowCount(row, COUNT_CEILING);
  const indexed = settings ? await TableSemantic.indexedCount(tableId) : 0;
  const held = awaitsConfirm(settings, rows);
  const paused = !settings ? undefined : held ? overCapReason(rows, capped) : pausedReason();
  const fields = await TableFields.listFields(tableId);
  return {
    tableId,
    tableName: row.name,
    enabled: settings !== null,
    rows,
    rowsCapped: capped,
    rowCap: SEMANTIC_ROW_CAP,
    needsConfirmation: rows > SEMANTIC_ROW_CAP,
    indexed,
    state: !settings ? 'off' : completed.has(tableId) && !held ? 'ready' : 'indexing',
    ...(held ? { awaitingConfirm: true } : {}),
    ...(paused ? { paused } : {}),
    estimate: estimateSemanticSize(rows),
    cardFields: cardFields(fields).map((field) => field.name),
    excludedByName: fields
      .filter((field) => !field.managed && isSensitiveFieldName(field.name))
      .map((field) => field.name),
    warning: NAME_RULE_WARNING,
  };
}

/**
 * Turn semantic search on or off for one table. On: refused above
 * {@link SEMANTIC_ROW_CAP} rows unless `confirm` is true, and the answer
 * carries the size estimate either way. Off: the table's vectors are deleted
 * with the switch, and the choice is remembered so the default never turns
 * the table back on.
 */
export async function setSemanticSearch(
  tableId: string,
  input: { enabled: boolean; confirm?: boolean }
): Promise<SemanticStatus> {
  if (typeof input.enabled !== 'boolean') throw badRequest('enabled must be true or false.');
  if (input.confirm !== undefined && typeof input.confirm !== 'boolean')
    throw badRequest('confirm must be true or false.');
  const row = await customTable(tableId);
  if (!input.enabled) {
    // Recorded first: a table left on after a failed disable is harmless, an
    // unrecorded off would let the boot default turn it back on.
    await recordTurnedOff(tableId);
    await TableSemantic.disable(tableId);
    resetTable(tableId);
    return getSemanticStatus(tableId);
  }
  const { rows, capped } = await TableCatalog.boundedRowCount(row, COUNT_CEILING);
  if (rows > SEMANTIC_ROW_CAP && input.confirm !== true) {
    const estimate = estimateSemanticSize(rows);
    throw badRequest(
      `${row.name} has ${capped ? `over ${rows.toLocaleString('en-US')}` : rows.toLocaleString('en-US')} rows, more than the ${SEMANTIC_ROW_CAP.toLocaleString('en-US')} a table may index without confirmation. ` +
        `Indexing it takes ${estimate.label}${capped ? ' or more' : ''}. Pass confirm: true to turn it on.`
    );
  }
  await TableSemantic.enable(tableId, rows > SEMANTIC_ROW_CAP ? rows : null);
  await clearTurnedOff(tableId);
  resetTable(tableId);
  return getSemanticStatus(tableId);
}

async function usableProvider(): Promise<EmbeddingProvider | null> {
  const provider = await resolveEmbeddingProvider();
  if (!provider) return null;
  if (provider.info.dimensions !== VECTOR_DIMENSIONS) {
    logger.warn(
      `[table-semantic] embedder makes ${provider.info.dimensions}-dimension vectors; the index holds ${VECTOR_DIMENSIONS}`
    );
    return null;
  }
  return provider;
}

/** A bounded, parent-job-owned semantic index target. No worker cursor state is involved. */
export interface SemanticEntryTarget {
  tableId: string;
  tableName: string;
  entryId: string;
  modelId: string;
  card: string;
  cardHash: string;
  state: 'missing' | 'stale';
}

export interface SemanticEntryClassification {
  fresh: number;
  missing: number;
  stale: number;
  target: SemanticEntryTarget[];
}

/** Classify enabled active custom-table rows without touching worker cursor state. */
export async function classifySemanticEntries(
  model?: string
): Promise<SemanticEntryClassification> {
  const provider = await usableProvider();
  if (!provider) return { fresh: 0, missing: 0, stale: 0, target: [] };
  const modelId = model ?? provider.info.model;
  const result: SemanticEntryClassification = { fresh: 0, missing: 0, stale: 0, target: [] };
  for (const tableId of await TableSemantic.listEnabled()) {
    const table = await TableCatalog.findById(tableId);
    if (!table || table.origin !== 'custom' || table.state !== 'active') continue;
    // Past the cap without a confirmation: the Embeddings pane's backfill waits too.
    if (await heldOverCap(table)) continue;
    const fields = cardFields(await TableFields.listFields(tableId));
    if (!fields.length) continue;
    const target = `${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(table.tableName)}`;
    let after: string | undefined;
    for (;;) {
      const { rows } = await getDb().query<Record<string, unknown> & { id: string }>(
        `SELECT id::text AS id, ${cardSelect(fields)} FROM ONLY ${target}
          ${after ? 'WHERE id > $1::uuid' : ''} ORDER BY id LIMIT ${after ? '$2' : '$1'}`,
        after ? [after, SEMANTIC_PAGE_ROWS] : [SEMANTIC_PAGE_ROWS]
      );
      if (!rows.length) break;
      const stored = await TableSemantic.hashes(
        tableId,
        rows.map((row) => row.id)
      );
      for (const row of rows) {
        const card = buildCard(table.name, fields, row);
        if (!card) continue;
        const hash = cardHash(modelId, card);
        const existing = stored.get(row.id);
        if (existing === hash) result.fresh += 1;
        else {
          const state = existing === undefined ? 'missing' : 'stale';
          result[state] += 1;
          result.target.push({
            tableId,
            tableName: table.name,
            entryId: row.id,
            modelId,
            card,
            cardHash: hash,
            state,
          });
        }
      }
      after = rows[rows.length - 1]!.id;
      if (rows.length < SEMANTIC_PAGE_ROWS) break;
    }
  }
  return result;
}

/** Embed one target, rechecking setting and current card/hash before writing. */
export async function embedSemanticEntryTarget(target: SemanticEntryTarget): Promise<boolean> {
  if (!(await TableSemantic.getSettings(target.tableId))) return false;
  const provider = await usableProvider();
  if (!provider || provider.info.model !== target.modelId) return false;
  const table = await TableCatalog.findById(target.tableId);
  if (!table || table.origin !== 'custom' || table.state !== 'active') return false;
  const fields = cardFields(await TableFields.listFields(target.tableId));
  if (!fields.length) return false;
  const tableName = `${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(table.tableName)}`;
  const { rows } = await getDb().query<Record<string, unknown> & { id: string }>(
    `SELECT id::text AS id, ${cardSelect(fields)} FROM ONLY ${tableName} WHERE id = $1::uuid`,
    [target.entryId]
  );
  const row = rows[0];
  if (!row) return false;
  const card = buildCard(table.name, fields, row);
  if (!card) return false;
  const hash = cardHash(target.modelId, card);
  const stored = await TableSemantic.hashes(target.tableId, [target.entryId]);
  if (stored.get(target.entryId) === hash) return false;
  const vector = await provider.embedDocument(card);

  // The model call yields: re-check policy, row existence, and card hash before
  // writing so a disabled/deleted/edited row is never resurrected.
  if (!(await TableSemantic.getSettings(target.tableId))) return false;
  const currentProvider = await usableProvider();
  if (!currentProvider || currentProvider.info.model !== target.modelId) return false;
  const currentTable = await TableCatalog.findById(target.tableId);
  if (!currentTable || currentTable.origin !== 'custom' || currentTable.state !== 'active')
    return false;
  const currentFields = cardFields(await TableFields.listFields(target.tableId));
  if (!currentFields.length) return false;
  const currentName = `${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(currentTable.tableName)}`;
  const currentResult = await getDb().query<Record<string, unknown> & { id: string }>(
    `SELECT id::text AS id, ${cardSelect(currentFields)} FROM ONLY ${currentName} WHERE id = $1::uuid`,
    [target.entryId]
  );
  const currentRow = currentResult.rows[0];
  const currentCard = currentRow ? buildCard(currentTable.name, currentFields, currentRow) : null;
  if (!currentCard || cardHash(target.modelId, currentCard) !== hash) return false;

  await TableSemantic.upsert(target.tableId, target.modelId, [
    { entryId: target.entryId, cardHash: hash, vector },
  ]);
  return true;
}

/** `SELECT` expressions for the card's cells, each cut a character past the cell limit. */
function cardSelect(fields: ReturnType<typeof cardFields>): string {
  return fields
    .map((field) => {
      const column = quoteIdentifier(field.columnName);
      const value = field.multiple ? `array_to_string(${column}, ', ')` : `${column}::text`;
      return `left(${value}, ${CARD_CELL_MAX_CHARS + 1}) AS ${column}`;
    })
    .join(', ');
}

/**
 * One tick of the background build: for each table with it on, read its next
 * page of rows, embed those whose card changed (up to `embedBudget` across
 * tables), delete the vector of a row with no card, and, at the end of a pass,
 * the vectors of rows that no longer exist. A table that grew past the cap
 * without a person's confirmation is skipped (its vectors stay) until someone
 * confirms. Returns how many rows it embedded. Keyword search never waits on it.
 */
export async function sweepTableEntries(
  options: { embedBudget?: number; tableIds?: readonly string[] } = {}
): Promise<number> {
  let budget = options.embedBudget ?? SWEEP_EMBEDS_PER_TICK;
  const enabled = (await TableSemantic.listEnabled()).filter(
    (id) => !options.tableIds || options.tableIds.includes(id)
  );
  if (!enabled.length) return 0;
  const provider = await usableProvider();
  if (!provider) return 0;
  const modelId = provider.info.model;
  let embedded = 0;
  for (const tableId of enabled) {
    if (budget <= 0) break;
    if (completed.has(tableId) && Date.now() - (passedAt.get(tableId) ?? 0) < REPASS_AFTER_MS)
      continue;
    const table = await TableCatalog.findById(tableId);
    if (!table || table.origin !== 'custom' || table.state !== 'active') continue;
    if (await heldOverCap(table)) {
      heldAtCap.add(tableId);
      completed.delete(tableId);
      continue;
    }
    heldAtCap.delete(tableId);
    const fields = await TableFields.listFields(tableId);
    const used = cardFields(fields);
    if (!used.length) {
      finishPass(tableId);
      continue;
    }
    const target = `${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(table.tableName)}`;
    const after = cursors.get(tableId);
    let page: Array<Record<string, unknown> & { id: string }>;
    try {
      ({ rows: page } = await getDb().query<Record<string, unknown> & { id: string }>(
        `SELECT id::text AS id, ${cardSelect(used)} FROM ONLY ${target}
          ${after ? 'WHERE id > $2::uuid' : ''} ORDER BY id LIMIT $1`,
        after ? [SWEEP_PAGE_ROWS, after] : [SWEEP_PAGE_ROWS]
      ));
    } catch (error) {
      // A table whose columns changed under the read: try it again next tick.
      logger.warn(`[table-semantic] ${table.name}: ${getErrorMessage(error)}`);
      continue;
    }
    if (!page.length) {
      await TableSemantic.deleteOrphans(tableId, table.tableName);
      cursors.delete(tableId);
      finishPass(tableId);
      continue;
    }
    const cards = page.map((row) => ({ id: row.id, card: buildCard(table.name, fields, row) }));
    const stored = await TableSemantic.hashes(
      tableId,
      cards.map((item) => item.id)
    );
    const empty = cards.filter((item) => item.card === null && stored.has(item.id));
    if (empty.length)
      await TableSemantic.deleteEntries(
        tableId,
        empty.map((item) => item.id)
      );
    let last: string | undefined;
    let stoppedEarly = false;
    for (const item of cards) {
      if (item.card === null) {
        last = item.id;
        continue;
      }
      const hash = cardHash(modelId, item.card);
      if (stored.get(item.id) === hash) {
        last = item.id;
        continue;
      }
      if (budget <= 0) {
        stoppedEarly = true;
        break;
      }
      try {
        const vector = await provider.embedDocument(item.card);
        await TableSemantic.upsert(tableId, modelId, [
          { entryId: item.id, cardHash: hash, vector },
        ]);
        budget -= 1;
        embedded += 1;
        last = item.id;
      } catch (error) {
        logger.warn(`[table-semantic] embed failed in ${table.name}: ${getErrorMessage(error)}`);
        stoppedEarly = true;
        break;
      }
    }
    if (last !== undefined) cursors.set(tableId, last);
    if (stoppedEarly) completed.delete(tableId);
  }
  return embedded;
}

/**
 * Run the sweep until every enabled table has finished a pass or is held at
 * the cap (tests and the enable path).
 */
export async function buildSemanticIndex(): Promise<number> {
  let total = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    const enabled = await TableSemantic.listEnabled();
    if (enabled.every((id) => completed.has(id) || heldAtCap.has(id))) return total;
    total += await sweepTableEntries({ embedBudget: SWEEP_PAGE_ROWS });
  }
  return total;
}

export interface SemanticSearchResult {
  hits: SemanticHit[];
  /** Tables among those asked about that have it on. */
  tableIds: string[];
  /** Of those, the ones whose build is not finished: results may be missing rows. */
  indexing: string[];
  /** Why those are not being built: past the cap without a confirmation, or the build is off. */
  paused?: string;
}

/**
 * The rows of the tables (that have it on) nearest `query` in meaning.
 * Throws if the embedder cannot embed the query; callers fall back to
 * keyword search.
 */
export async function searchSemantic(
  tableIds: readonly string[],
  query: string,
  limit: number
): Promise<SemanticSearchResult> {
  const enabled = await TableSemantic.enabledAmong(tableIds);
  if (!enabled.length) return { hits: [], tableIds: [], indexing: [] };
  const provider = await usableProvider();
  if (!provider) throw new Error('The local embedder is not available.');
  const vector = await provider.embedQuery(query);
  const hits = await TableSemantic.nearest(enabled, provider.info.model, vector, limit);
  const indexing = enabled.filter((id) => !completed.has(id));
  const held = indexing.some((id) => heldAtCap.has(id));
  const paused = held
    ? `A table grew past ${SEMANTIC_ROW_CAP.toLocaleString('en-US')} rows; its other rows wait for a person to turn on indexing them.`
    : indexing.length
      ? pausedReason()
      : undefined;
  return { hits, tableIds: enabled, indexing, ...(paused ? { paused } : {}) };
}

/** Tables with a backfill running now, so a second click does not start a second loop. */
const backfilling = new Set<string>();

async function runBackfill(tableId: string): Promise<void> {
  let idle = 0;
  for (let guard = 0; guard < 100_000; guard++) {
    if (!(await TableSemantic.getSettings(tableId))) return; // turned off meanwhile
    const before = cursors.get(tableId);
    const embedded = await sweepTableEntries({ embedBudget: SWEEP_PAGE_ROWS, tableIds: [tableId] });
    if (completed.has(tableId)) return;
    // A page of unchanged rows embeds nothing but moves the cursor on, so that is progress.
    // Only a pass that embeds nothing AND leaves the cursor where it was means the embedder is
    // failing: stop, do not spin.
    const moved = cursors.get(tableId) !== before;
    idle = embedded === 0 && !moved ? idle + 1 : 0;
    if (idle >= 3) return;
  }
}

/**
 * Backfill one table that has it on, now: embed rows that have no vector or whose
 * card changed, drop vectors of rows that are gone. Runs in the background and
 * answers at once with the table's status; the embeddings pane polls it. It
 * works whether or not automatic local intelligence is on, because a person
 * asked for it.
 */
export async function backfillSemanticTable(tableId: string): Promise<SemanticStatus> {
  await customTable(tableId);
  if (!(await TableSemantic.getSettings(tableId)))
    throw badRequest('Turn on search by meaning for this table first.');
  if (!backfilling.has(tableId)) {
    // A second click while one runs must not move the running loop's cursor back to the start.
    resetTable(tableId);
    backfilling.add(tableId);
    void runBackfill(tableId)
      .catch((error: unknown) =>
        logger.warn(`[table-semantic] backfill failed: ${getErrorMessage(error)}`)
      )
      .finally(() => backfilling.delete(tableId));
  }
  return getSemanticStatus(tableId);
}

/**
 * Every active custom table with its switch and coverage, for the embeddings
 * pane: on or off, rows, indexed rows and size. Archived or deleted tables
 * are left out.
 */
export async function listSemanticTables(): Promise<SemanticTableRow[]> {
  const tables = await TableCatalog.listTables({ origin: 'custom' });
  const enabled = new Set(await TableSemantic.listEnabled());
  const projectIds = [...new Set(tables.flatMap((table) => table.projectId ?? []))];
  const projects = new Map(
    projectIds.length
      ? (
          await getDb().query<{ id: string; name: string }>(
            'SELECT id, name FROM public.containers WHERE id = ANY($1::text[])',
            [projectIds]
          )
        ).rows.map((project) => [project.id, project.name])
      : []
  );
  const paused = pausedReason();
  const rows: SemanticTableRow[] = [];
  for (const table of tables) {
    const settings = enabled.has(table.id) ? await TableSemantic.getSettings(table.id) : null;
    const on = settings !== null;
    const { rows: count, capped } = await TableCatalog.boundedRowCount(table, COUNT_CEILING);
    const held = awaitsConfirm(settings, count);
    const reason = held ? overCapReason(count, capped) : on ? paused : undefined;
    rows.push({
      tableId: table.id,
      tableName: table.name,
      projectName: (table.projectId && projects.get(table.projectId)) || null,
      enabled: on,
      rows: count,
      rowsCapped: capped,
      needsConfirmation: count > SEMANTIC_ROW_CAP,
      indexed: on ? await TableSemantic.indexedCount(table.id) : 0,
      state: !on ? 'off' : completed.has(table.id) && !held ? 'ready' : 'indexing',
      ...(held ? { awaitingConfirm: true } : {}),
      ...(reason ? { paused: reason } : {}),
      estimate: estimateSemanticSize(count),
    });
  }
  return rows.sort((a, b) => a.tableName.localeCompare(b.tableName));
}
