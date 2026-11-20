/**
 * Picker search for relation fields that link to Snaglet items (docs, projects,
 * containers, threads, images, Board posts, agents). Only the
 * allowlisted kinds resolve; every result is a live item's id, title and
 * context line.
 */
import { TableReferences } from '@snaglet/db/tables/table_references';
import { TABLE_REFERENCE_KINDS, type TableReferenceSearchResponse } from '@snaglet/shared/types';
import { isTableReferenceKind } from '@snaglet/shared/utils';
import { idList, offsetNumber, pageNumber, tableBadRequest } from './tableValidation';

export async function searchTableReferences(
  input: unknown = {}
): Promise<TableReferenceSearchResponse> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw tableBadRequest('Request must be an object.');
  const query = input as Record<string, unknown>;
  if (!isTableReferenceKind(query.kind))
    throw tableBadRequest(`kind must be one of ${TABLE_REFERENCE_KINDS.join(', ')}.`);
  if (query.q !== undefined && typeof query.q !== 'string')
    throw tableBadRequest('q must be text.');
  return TableReferences.search({
    kind: query.kind,
    ...(query.q !== undefined ? { q: query.q } : {}),
    limit: pageNumber(query.limit, 'limit'),
    offset: offsetNumber(query.offset),
    exclude: idList(query.exclude, 'exclude', 'item ids'),
  });
}
