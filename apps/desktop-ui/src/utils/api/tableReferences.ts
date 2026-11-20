/**
 * Snaglet item search for relation fields that link to Snaglet items —
 * `GET /api/tables/references/search`. A non-2xx response surfaces as a
 * thrown `FetchError` with the server's message (400 for an unknown kind or
 * out-of-range paging).
 */

import type {
  TableReferenceSearchQuery,
  TableReferenceSearchResponse,
} from '@snaglet/shared/types';
import { fetchData, getApiUrl } from './core';

export const tableReferencesApi = {
  /** Live items of one kind, best match first; page with `offset` while `hasMore`. */
  search: (query: TableReferenceSearchQuery) => {
    const params = new URLSearchParams({ kind: query.kind });
    if (query.q !== undefined) params.set('q', query.q);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    if (query.exclude?.length) params.set('exclude', query.exclude.join(','));
    return fetchData<TableReferenceSearchResponse>(
      getApiUrl(`/tables/references/search?${params}`)
    );
  },
};
