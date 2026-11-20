/**
 * What a relation picker links to: entries of a custom table
 * ({@link entrySource}) or one kind of Snaglet item ({@link snagletItemSource}). A
 * source searches, names its values and renders their chips, so one picker
 * serves both.
 */
import { createElement, type ReactNode } from 'react';
import {
  TABLE_ENTRY_SEARCH_MAX_OFFSET,
  TABLE_ENTRY_SEARCH_QUERY_MAX_LENGTH,
  type RelatedTableEntries,
  type RelatedTableItems,
  type TableReferenceKind,
} from '@snaglet/shared/types';
import { tableReferenceKindArticle, tableReferenceKindName } from '@snaglet/shared/utils';
import { EntryReferenceChip } from '@desktop/features/table-entries';
import { SnagletReferenceChip } from '@desktop/features/table-entries/SnagletReferenceChip';
import { knownItem, rememberItem } from '@desktop/features/table-entries/snagletItemTitles';
import { tablesApi } from '@desktop/utils/api';
import { tableReferencesApi } from '@desktop/utils/api/tableReferences';

/** One search result as a picker lists it. */
export interface RelationChoice {
  id: string;
  label: string;
  /** A quieter second line: an entry's preview values, or an item's container or role. */
  secondary?: string;
}

interface RelationSearch {
  q: string;
  limit: number;
  offset: number;
  exclude: string[];
}

export interface RelationSource {
  /** Changing it restarts the search and forgets learned labels; null has nothing to search. */
  key: string | null;
  /** Shown instead of results when `key` is null. */
  missingTarget: string;
  /** Entries read "Untitled N" through the live entry-name cache; items have titles. */
  entryTableId: string | null;
  noun: { one: string; many: string; article: string };
  /** Entry UUIDs compare ignoring case; item ids exactly. */
  normalize(id: string): string;
  search(query: RelationSearch): Promise<{ results: RelationChoice[]; hasMore: boolean }>;
  maxOffset: number;
  maxQueryLength: number;
  /** A value's label as the page names it, if it does. */
  pageLabel(id: string): string | undefined;
  /** Called with a result the user picked, before it is linked. */
  remember(choice: RelationChoice): void;
  /** A linked value's chip inside the picker (not interactive, not draggable). */
  renderChip(id: string, label: string | undefined): ReactNode;
}

/** Entries of the custom table `tableId` (null until field settings choose one). */
export function entrySource(
  tableId: string | null,
  relatedEntries: RelatedTableEntries | undefined
): RelationSource {
  return {
    key: tableId,
    missingTarget: 'Choose a table in field settings first.',
    entryTableId: tableId,
    noun: { one: 'entry', many: 'entries', article: 'an entry' },
    normalize: (id) => id.toLowerCase(),
    search: async ({ q, limit, offset, exclude }) => {
      if (!tableId) return { results: [], hasMore: false };
      const page = await tablesApi.searchEntries(tableId, { q, limit, offset, exclude });
      return {
        hasMore: page.hasMore,
        results: page.results.map((entry) => ({
          id: entry.id,
          label: entry.name,
          ...(entry.preview ? { secondary: entry.preview } : {}),
        })),
      };
    },
    maxOffset: TABLE_ENTRY_SEARCH_MAX_OFFSET,
    maxQueryLength: TABLE_ENTRY_SEARCH_QUERY_MAX_LENGTH,
    pageLabel: (id) => (tableId ? relatedEntries?.[tableId]?.[id]?.name : undefined),
    remember: () => undefined,
    renderChip: (id, label) =>
      tableId
        ? createElement(EntryReferenceChip, {
            tableId,
            entryId: id,
            name: label,
            interactive: false,
            draggable: false,
          })
        : null,
  };
}

/** Live Snaglet items of one kind (docs, agents, …), searched by title. */
export function snagletItemSource(
  kind: TableReferenceKind,
  relatedItems: RelatedTableItems | undefined
): RelationSource {
  return {
    key: `snaglet:${kind}`,
    missingTarget: 'Choose what this relation links to in field settings first.',
    entryTableId: null,
    noun: {
      one: tableReferenceKindName(kind),
      many: tableReferenceKindName(kind, true),
      article: tableReferenceKindArticle(kind),
    },
    normalize: (id) => id,
    search: async ({ q, limit, offset, exclude }) => {
      const page = await tableReferencesApi.search({ kind, q, limit, offset, exclude });
      return {
        hasMore: page.hasMore,
        results: page.results.map((item) => ({
          id: item.id,
          label: item.title,
          ...(item.context ? { secondary: item.context } : {}),
        })),
      };
    },
    maxOffset: TABLE_ENTRY_SEARCH_MAX_OFFSET,
    maxQueryLength: TABLE_ENTRY_SEARCH_QUERY_MAX_LENGTH,
    pageLabel: (id) => knownItem(kind, id, relatedItems)?.title,
    // Search only returns live items; the chip reads the title until the page names it.
    remember: (choice) => rememberItem(kind, choice.id, { title: choice.label, archived: false }),
    renderChip: (id) =>
      createElement(SnagletReferenceChip, {
        kind,
        id,
        relatedItems,
        interactive: false,
        draggable: false,
      }),
  };
}
