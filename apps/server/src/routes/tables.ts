/**
 * Table routes under /api/tables: the catalog, fields, entries, repeats,
 * search by meaning, undo/redo history and archive/delete. Every write is a
 * step in the caller's undo history. The catalog is `public.table_catalog`
 * (see docs/architecture.md).
 */

import { Router } from 'express';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import type {
  SemanticOverviewResponse,
  ArchivedTableFieldsResponse,
  ArchivedTablesResponse,
  CreateTableResponse,
  DeleteTableEntriesResponse,
  RenameTableResponse,
  ResolveTableEntriesResponse,
  TableDetailResponse,
  TableEntrySearchResponse,
  TableFieldResponse,
  TableFieldsResponse,
  TableListResponse,
  TableSelectOptionUsageResponse,
  TableFieldLifecycleResponse,
  TableHistoryResponse,
  TableHistoryStepResponse,
  TableLifecycleResponse,
  TableReferenceSearchResponse,
  SetTableProjectResponse,
  UpdateTablePlacementRequest,
} from '@snaglet/shared/types';
import { asyncHandler } from '@server/middleware';
import { sendCreated, sendOk } from '@server/utils/http';
import {
  assertTablePlacement,
  createTable,
  getTableDetail,
  listTables,
  renameTable,
  updateTablePlacement,
} from '@server/domains/tables/tableCatalog';
import {
  createTableField,
  listTableFields,
  reorderTableFields,
  selectOptionUsage,
  setTableFieldCalendar,
  updateTableField,
  updateTableFieldView,
} from '@server/domains/tables/tableFields';
import {
  createTableEntries,
  createTableEntry,
  deleteTableEntries,
  getTableEntry,
  listTableEntries,
  resolveTableEntries,
  getTableEntryRepeats,
  getTableRepeats,
  searchTableEntries,
  tableEntryRepeatAction,
  updateTableEntry,
  type RepeatAction,
} from '@server/domains/tables/tableEntries';
import {
  parseCustomTableId,
  parseTableName,
  parseTableOriginFilter,
  parseTableProjectFilter,
  parseTableProjectId,
  parseTableSortOrder,
  tableBadRequest,
} from '@server/domains/tables/tableValidation';
import { listTableHistory, stepTableHistory } from '@server/domains/tables/tableHistory';
import {
  backfillSemanticTable,
  getSemanticStatus,
  listSemanticTables,
  setSemanticSearch,
} from '@server/services/tableSemantic/TableSemanticService';
import { searchTableReferences } from '@server/domains/tables/tableReferences';
import {
  archiveTable,
  archiveTableField,
  deleteTable,
  deleteTableField,
  listArchivedTableFields,
  listArchivedTables,
  purgeTableField,
  restoreTable,
  restoreTableField,
  setTableTitleField,
} from '@server/domains/tables/tableLifecycle';

const router = Router();

// Literal segments, registered before every `/:id/...` route.
router.get(
  '/semantic-search',
  asyncHandler(async (_req, res) => {
    const body: SemanticOverviewResponse = { tables: await listSemanticTables() };
    sendOk(res, body);
  })
);

router.get(
  '/references/search',
  asyncHandler(async (req, res) => {
    const body: TableReferenceSearchResponse = await searchTableReferences(req.query);
    sendOk(res, body);
  })
);

router.get(
  '/history',
  asyncHandler(async (req, res) => {
    const body: TableHistoryResponse = await listTableHistory(req.query);
    sendOk(res, body);
  })
);

router.post(
  '/history/undo',
  asyncHandler(async (req, res) => {
    const body: TableHistoryStepResponse = await stepTableHistory('undo', req.body);
    sendOk(res, body);
  })
);

router.post(
  '/history/redo',
  asyncHandler(async (req, res) => {
    const body: TableHistoryStepResponse = await stepTableHistory('redo', req.body);
    sendOk(res, body);
  })
);

router.get(
  '/archived',
  asyncHandler(async (_req, res) => {
    const body: ArchivedTablesResponse = await listArchivedTables();
    sendOk(res, body);
  })
);

router.post(
  '/:id/archive',
  asyncHandler(async (req, res) => {
    const body: TableLifecycleResponse = await archiveTable(req.params.id);
    sendOk(res, body);
  })
);

router.post(
  '/:id/restore',
  asyncHandler(async (req, res) => {
    const body: TableLifecycleResponse = await restoreTable(req.params.id, req.body);
    sendOk(res, body);
  })
);

router.post(
  '/:id/delete',
  asyncHandler(async (req, res) => {
    const body: TableLifecycleResponse = await deleteTable(req.params.id, req.body);
    sendOk(res, body);
  })
);

router.put(
  '/:id/title',
  asyncHandler(async (req, res) => {
    const body: TableFieldsResponse = await setTableTitleField(req.params.id, req.body);
    sendOk(res, body);
  })
);

router.get(
  '/:id/fields/archived',
  asyncHandler(async (req, res) => {
    const body: ArchivedTableFieldsResponse = await listArchivedTableFields(req.params.id);
    sendOk(res, body);
  })
);

router.post(
  '/:id/fields/:fieldId/archive',
  asyncHandler(async (req, res) => {
    const body: TableFieldLifecycleResponse = await archiveTableField(
      req.params.id,
      req.params.fieldId
    );
    sendOk(res, body);
  })
);

router.post(
  '/:id/fields/:fieldId/restore',
  asyncHandler(async (req, res) => {
    const body: TableFieldLifecycleResponse & { madeOptional: boolean } = await restoreTableField(
      req.params.id,
      req.params.fieldId,
      req.body
    );
    sendOk(res, body);
  })
);

router.post(
  '/:id/fields/:fieldId/delete',
  asyncHandler(async (req, res) => {
    const body: TableFieldLifecycleResponse = await deleteTableField(
      req.params.id,
      req.params.fieldId
    );
    sendOk(res, body);
  })
);

// Drop a field and every value in it for good (not undoable), in any state.
router.delete(
  '/:id/fields/:fieldId',
  asyncHandler(async (req, res) => {
    const body: TableFieldLifecycleResponse = await purgeTableField(
      req.params.id,
      req.params.fieldId
    );
    sendOk(res, body);
  })
);

// Registered before every `/:id/...` route so literal segments always win.
router.post(
  '/entries/resolve',
  asyncHandler(async (req, res) => {
    const body: ResolveTableEntriesResponse = await resolveTableEntries(req.body);
    sendOk(res, body);
  })
);

router.get(
  '/:id/entries',
  asyncHandler(async (req, res) => {
    sendOk(res, await listTableEntries(req.params.id, req.query));
  })
);

// Before `/:id/entries/:entryId`, which would otherwise take "search" as an entry id.
router.get(
  '/:id/entries/search',
  asyncHandler(async (req, res) => {
    const body: TableEntrySearchResponse = await searchTableEntries(req.params.id, req.query);
    sendOk(res, body);
  })
);

router.get(
  '/:id/entries/:entryId',
  asyncHandler(async (req, res) => {
    sendOk(res, await getTableEntry(req.params.id, req.params.entryId));
  })
);

router.post(
  '/:id/entries',
  asyncHandler(async (req, res) => {
    const { created, ...body } = await createTableEntry(req.params.id, req.body);
    if (created) sendCreated(res, body);
    else sendOk(res, body);
  })
);

router.post(
  '/:id/entries/batch',
  asyncHandler(async (req, res) => {
    const { created, ...body } = await createTableEntries(req.params.id, req.body);
    if (created) sendCreated(res, body);
    else sendOk(res, body);
  })
);

router.post(
  '/:id/entries/delete',
  asyncHandler(async (req, res) => {
    const body: DeleteTableEntriesResponse = await deleteTableEntries(req.params.id, req.body);
    sendOk(res, body);
  })
);

router.patch(
  '/:id/entries/:entryId',
  asyncHandler(async (req, res) => {
    sendOk(res, await updateTableEntry(req.params.id, req.params.entryId, req.body));
  })
);

router.get(
  '/:id/repeats',
  asyncHandler(async (req, res) => {
    sendOk(res, await getTableRepeats(req.params.id));
  })
);

router.get(
  '/:id/entries/:entryId/repeats',
  asyncHandler(async (req, res) => {
    sendOk(res, await getTableEntryRepeats(req.params.id, req.params.entryId));
  })
);

router.put(
  '/:id/entries/:entryId/repeats/:fieldId',
  asyncHandler(async (req, res) => {
    const { id, entryId, fieldId } = req.params;
    sendOk(res, await tableEntryRepeatAction(id, entryId, fieldId, 'set', req.body));
  })
);

router.delete(
  '/:id/entries/:entryId/repeats/:fieldId',
  asyncHandler(async (req, res) => {
    const { id, entryId, fieldId } = req.params;
    // The revision pair may come as a JSON body or as query parameters.
    const body: unknown = { ...req.query, ...(req.body ?? {}) };
    sendOk(res, await tableEntryRepeatAction(id, entryId, fieldId, 'clear', body));
  })
);

const OCCURRENCE_ACTIONS: ReadonlySet<RepeatAction> = new Set([
  'complete',
  'skip',
  'move',
  'shift',
]);

router.post(
  '/:id/entries/:entryId/repeats/:fieldId/:action',
  asyncHandler(async (req, res) => {
    const { id, entryId, fieldId, action } = req.params;
    if (!OCCURRENCE_ACTIONS.has(action as RepeatAction)) {
      throw new AppError(
        `Unknown repeat action "${action}".`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    sendOk(
      res,
      await tableEntryRepeatAction(id, entryId, fieldId, action as RepeatAction, req.body)
    );
  })
);

router.post(
  '/:id/entries/:entryId/occurrences/:occurrenceId/undo',
  asyncHandler(async (req, res) => {
    const { id, entryId, occurrenceId } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fieldId = typeof body.fieldId === 'string' ? body.fieldId : '';
    sendOk(
      res,
      await tableEntryRepeatAction(id, entryId, fieldId, 'undoOccurrence', {
        ...body,
        occurrenceId,
      })
    );
  })
);

router.get(
  '/:id/semantic-search',
  asyncHandler(async (req, res) => {
    sendOk(res, await getSemanticStatus(parseCustomTableId(req.params.id)));
  })
);

router.post(
  '/:id/semantic-search/backfill',
  asyncHandler(async (req, res) => {
    sendOk(res, await backfillSemanticTable(parseCustomTableId(req.params.id)));
  })
);

router.put(
  '/:id/semantic-search',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as { enabled?: unknown; confirm?: unknown };
    sendOk(
      res,
      await setSemanticSearch(parseCustomTableId(req.params.id), {
        enabled: body.enabled as boolean,
        ...(body.confirm !== undefined ? { confirm: body.confirm as boolean } : {}),
      })
    );
  })
);

router.get(
  '/:id/fields',
  asyncHandler(async (req, res) => {
    const body: TableFieldsResponse = { fields: await listTableFields(req.params.id) };
    sendOk(res, body);
  })
);

router.post(
  '/:id/fields',
  asyncHandler(async (req, res) => {
    const result = await createTableField(req.params.id, req.body);
    const body: TableFieldResponse = { field: result.field };
    if (result.created) sendCreated(res, body);
    else sendOk(res, body);
  })
);

router.put(
  '/:id/fields/order',
  asyncHandler(async (req, res) => {
    const body: TableFieldsResponse = {
      fields: await reorderTableFields(req.params.id, req.body),
    };
    sendOk(res, body);
  })
);

router.patch(
  '/:id/fields/:fieldId/view',
  asyncHandler(async (req, res) => {
    const body: TableFieldResponse = {
      field: await updateTableFieldView(req.params.id, req.params.fieldId, req.body),
    };
    sendOk(res, body);
  })
);

router.put(
  '/:id/fields/:fieldId/calendar',
  asyncHandler(async (req, res) => {
    const body: TableFieldResponse = {
      field: await setTableFieldCalendar(req.params.id, req.params.fieldId, req.body),
    };
    sendOk(res, body);
  })
);

router.get(
  '/:id/fields/:fieldId/options/usage',
  asyncHandler(async (req, res) => {
    const body: TableSelectOptionUsageResponse = {
      usage: await selectOptionUsage(req.params.id, req.params.fieldId),
    };
    sendOk(res, body);
  })
);

router.patch(
  '/:id/fields/:fieldId',
  asyncHandler(async (req, res) => {
    const body: TableFieldResponse = {
      field: await updateTableField(req.params.id, req.params.fieldId, req.body),
    };
    sendOk(res, body);
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const origin = parseTableOriginFilter(req.query.origin);
    const projectId = parseTableProjectFilter(req.query.projectId);
    const body: TableListResponse = { tables: await listTables({ origin, projectId }) };
    sendOk(res, body);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const body: TableDetailResponse = await getTableDetail(req.params.id);
    sendOk(res, body);
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const raw: unknown = req.body;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw tableBadRequest('Request body must be an object with id and name');
    }
    const fields = raw as Record<string, unknown>;
    const id = parseCustomTableId(fields.id);
    const name = parseTableName(fields.name);
    const result = await createTable(
      fields.projectId === undefined
        ? { id, name }
        : { id, name, projectId: parseTableProjectId(fields.projectId) }
    );
    const body: CreateTableResponse = { table: result.table };
    if (result.created) sendCreated(res, body);
    else sendOk(res, body);
  })
);

const PATCH_TABLE_KEYS: ReadonlySet<string> = new Set([
  'name',
  'expectedName',
  'projectId',
  'sortOrder',
]);
const PATCH_TABLE_SHAPE =
  'Request body must be an object with name and expectedName, projectId and/or sortOrder, or both';

/**
 * One PATCH may rename (`name` + `expectedName`) and place (`projectId`
 * and/or `sortOrder`) at once. The placement is checked before anything is
 * written, so a refused target or slot (400, 404) changes nothing; the rename
 * then runs first, so a stale rename (409) changes nothing either; the
 * placement applies last and the response carries the entry as it is after
 * both.
 */
async function patchTable(
  id: string,
  fields: Record<string, unknown>
): Promise<RenameTableResponse | SetTableProjectResponse> {
  const unknown = Object.keys(fields).find((key) => !PATCH_TABLE_KEYS.has(key));
  if (unknown !== undefined) throw tableBadRequest(`Unknown field: ${unknown}`);
  const rename =
    'name' in fields || 'expectedName' in fields
      ? { name: parseTableName(fields.name), expectedName: parseTableName(fields.expectedName) }
      : null;
  const placement: UpdateTablePlacementRequest = {};
  if ('projectId' in fields) placement.projectId = parseTableProjectId(fields.projectId);
  if ('sortOrder' in fields) placement.sortOrder = parseTableSortOrder(fields.sortOrder);
  const placing = placement.projectId !== undefined || placement.sortOrder !== undefined;
  if (rename && placing) await assertTablePlacement(id, placement);
  const renamed = rename ? await renameTable(id, rename) : null;
  if (placing) return { table: await updateTablePlacement(id, placement) };
  if (renamed) return { table: renamed };
  throw tableBadRequest(PATCH_TABLE_SHAPE);
}

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const raw: unknown = req.body;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw tableBadRequest(PATCH_TABLE_SHAPE);
    }
    sendOk(res, await patchTable(req.params.id, raw as Record<string, unknown>));
  })
);

export default router;
