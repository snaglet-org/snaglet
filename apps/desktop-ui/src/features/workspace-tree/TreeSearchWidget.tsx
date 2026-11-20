import { useMemo } from 'react';
import { formatBytes } from '@snaglet/shared/utils';
import { PREFIX_FILTER_META, type PaletteNodeKind, type PaletteSearchHit } from '../../utils/api';
import { Button, SearchModeControl } from '@desktop/components';
import { Chip } from '@desktop/components/Chip';
import { SearchIcon } from '@desktop/components/Icons';
import {
  extractThreadSummaryDisplay,
  formatThreadSummaryDate,
} from '@desktop/utils/threadSummaryHit';
import styles from './WorkspaceTree.module.scss';
import { KIND_TO_TONE } from './treeHelpers';
import { getPaletteHitContext } from './searchUtils';
import type { useWorkspaceTreeSearch } from './useWorkspaceTreeSearch';

function searchKindLabel(kind: string): string {
  return PREFIX_FILTER_META[kind]?.label ?? kind.replace(/_/g, ' ');
}

function searchSectionLabel(kind: string): string {
  const label = searchKindLabel(kind);
  if (label === 'Memory') return 'Memories';
  if (label === 'Summary') return 'Thread summaries';
  return `${label}s`;
}

interface TreeSearchWidgetProps {
  /** The full search-state surface returned by `useWorkspaceTreeSearch`. */
  search: ReturnType<typeof useWorkspaceTreeSearch>;
}

/**
 * Sidebar search widget: filter chips + input row, the search-mode control,
 * and the results dropdown (node hits grouped by kind, then embedded file
 * and filesystem matches). All state and handlers live in
 * `useWorkspaceTreeSearch`; this component is presentation only.
 */
export function TreeSearchWidget({ search }: TreeSearchWidgetProps) {
  const {
    clearSearch,
    handleSearchChange,
    handleSearchKeyDown,
    handleSearchResultClick,
    handleFileResultClick,
    handleEntryResultClick,
    entryResults,
    hitLabel,
    hoverSearchRow,
    removeSearchFilterKind,
    removeFsFilter,
    removeEntryFilter,
    fsFilter,
    entryFilter,
    entryTable,
    fileResults,
    filesystemResults,
    searchActiveIndex,
    searchChannels,
    searchFilterKinds,
    searchLoading,
    searchOpen,
    searchQuery,
    searchResults,
    setSearchChannels,
    setSearchOpen,
  } = search;

  const searchResultSections = useMemo(() => {
    const sections = new Map<
      string,
      { key: string; label: string; items: Array<{ hit: PaletteSearchHit; index: number }> }
    >();
    searchResults.forEach((hit, index) => {
      const existing = sections.get(hit.kind);
      const section = existing ?? {
        key: hit.kind,
        label: searchSectionLabel(hit.kind),
        items: [],
      };
      section.items.push({ hit, index });
      sections.set(hit.kind, section);
    });
    return Array.from(sections.values());
  }, [searchResults]);

  return (
    <div className={styles.searchWidget}>
      <div className={styles.searchInputRow}>
        <SearchIcon className={styles.searchGlyph} />
        {searchFilterKinds.map((kind) => (
          <Chip
            key={kind}
            size="xs"
            tone={KIND_TO_TONE[kind as PaletteNodeKind] ?? 'muted'}
            onRemove={() => removeSearchFilterKind(kind)}
            removeLabel={`Remove ${searchKindLabel(kind)} filter`}
          >
            {searchKindLabel(kind)}
          </Chip>
        ))}
        {entryFilter && (
          <Chip
            size="xs"
            tone="muted"
            onRemove={removeEntryFilter}
            removeLabel="Remove entry filter"
          >
            {entryTable ? `Entry · ${entryTable}` : 'Entry'}
          </Chip>
        )}
        {fsFilter && (
          <Chip
            size="xs"
            tone="muted"
            onRemove={removeFsFilter}
            removeLabel={`Remove ${fsFilter} filter`}
          >
            {fsFilter === 'folder' ? 'Folder' : 'File'}
          </Chip>
        )}
        <input
          type="text"
          className={styles.searchInput}
          placeholder={
            searchFilterKinds.length > 0 || entryFilter ? 'Filter…' : 'Search…  (try docs:)'
          }
          value={searchQuery}
          onChange={handleSearchChange}
          onFocus={() => setSearchOpen(true)}
          onKeyDown={handleSearchKeyDown}
          aria-label="Search workspace tree"
        />
        {(searchQuery.trim() || searchFilterKinds.length > 0 || fsFilter || entryFilter) && (
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            className={styles.searchClear}
            aria-label="Clear search"
            onClick={clearSearch}
          >
            ×
          </Button>
        )}
      </div>
      <SearchModeControl
        value={searchChannels}
        onChange={setSearchChannels}
        context="workspace tree"
        className={styles.searchModeControl}
      />
      {searchOpen &&
        (searchQuery.trim() || searchFilterKinds.length > 0 || fsFilter || entryFilter) && (
          <div className={styles.searchResults} role="listbox">
            {searchLoading &&
            searchResults.length === 0 &&
            entryResults.length === 0 &&
            fileResults.length === 0 &&
            filesystemResults.length === 0 ? (
              <div className={styles.searchEmpty}>Searching…</div>
            ) : searchResults.length === 0 &&
              entryResults.length === 0 &&
              fileResults.length === 0 &&
              filesystemResults.length === 0 ? (
              <div className={styles.searchEmpty}>No matches</div>
            ) : (
              <>
                {searchResultSections.map((section) => (
                  <div key={section.key} role="presentation">
                    <div className={styles.searchSectionHeader}>{section.label}</div>
                    {section.items.map(({ hit, index }) => {
                      const summary =
                        hit.kind === 'thread_summary'
                          ? extractThreadSummaryDisplay(hit.payload)
                          : null;
                      const summaryMeta = summary
                        ? [summary.threadTitle, formatThreadSummaryDate(summary.createdAt)]
                            .filter(Boolean)
                            .join(' · ')
                        : null;
                      const resultMeta = summaryMeta ?? getPaletteHitContext(hit);
                      return (
                        <button
                          key={`${hit.kind}:${hit.node_id}`}
                          type="button"
                          role="option"
                          aria-selected={index === searchActiveIndex}
                          className={`${styles.searchResultRow} ${styles.searchResultRowKeyed} ${
                            index === searchActiveIndex ? styles.searchResultRowActive : ''
                          }`}
                          onMouseMove={(event) => hoverSearchRow(index, event)}
                          onClick={() => handleSearchResultClick(hit)}
                          title={resultMeta ? `${hitLabel(hit)} — ${resultMeta}` : hitLabel(hit)}
                        >
                          <span className={styles.searchResultBadges}>
                            <span className={styles.searchResultKind}>
                              {searchKindLabel(hit.kind)}
                            </span>
                          </span>
                          <span className={styles.searchResultLabel}>{hitLabel(hit)}</span>
                          {resultMeta && (
                            <span className={styles.searchResultMeta}>{resultMeta}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {/* Table rows (entries): open in their own window, ⌘/Ctrl-click highlights the row in its table. */}
                {entryResults.length > 0 && (
                  <div role="presentation">
                    <div className={styles.searchSectionHeader}>Table rows</div>
                    {entryResults.map((entry, i) => {
                      const index = searchResults.length + i;
                      return (
                        <button
                          key={`entry:${entry.tableId}/${entry.entryId}`}
                          type="button"
                          role="option"
                          aria-selected={index === searchActiveIndex}
                          className={`${styles.searchResultRow} ${styles.searchResultRowKeyed} ${
                            index === searchActiveIndex ? styles.searchResultRowActive : ''
                          }`}
                          onMouseMove={(event) => hoverSearchRow(index, event)}
                          onClick={(event) =>
                            handleEntryResultClick(entry, {
                              secondary: event.metaKey || event.ctrlKey,
                            })
                          }
                          title={`${entry.name || 'Untitled'} — ${entry.tableName}`}
                        >
                          <span className={styles.searchResultBadges}>
                            <span className={styles.searchResultKind}>Row</span>
                          </span>
                          <span className={styles.searchResultLabel}>
                            {entry.name || 'Untitled'}
                          </span>
                          <span className={styles.searchResultMeta}>{entry.tableName}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* Embedded file-node and filesystem matches are search results;
                  opening them is handled by the file preview surfaces. */}
                {fileResults.length > 0 && (
                  <div role="presentation">
                    <div className={styles.searchSectionHeader}>Files</div>
                    {fileResults.map((file) => (
                      <button
                        key={`file:${file.nodeId}`}
                        type="button"
                        role="option"
                        aria-selected={false}
                        className={styles.searchResultRow}
                        title={file.relativePath}
                        onClick={() => handleFileResultClick(file)}
                      >
                        <span className={styles.searchResultBadges}>
                          <span className={styles.searchResultKind}>File</span>
                        </span>
                        <span className={styles.searchResultLabel}>{file.relativePath}</span>
                        <span className={styles.searchResultMeta}>
                          {formatBytes(file.sizeBytes)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {filesystemResults.length > 0 && (
                  <div role="presentation">
                    <div className={styles.searchSectionHeader}>Filesystem</div>
                    {filesystemResults.map((item) =>
                      item.filesystemKind === 'folder' ? (
                        <div
                          key={`fs:${item.filesystemKind}:${item.path}`}
                          role="option"
                          aria-selected={false}
                          className={styles.searchResultRow}
                          title={item.path}
                        >
                          <span className={styles.searchResultKind}>Folder</span>
                          <span className={styles.searchResultLabel}>{item.name}</span>
                          <span className={styles.searchResultMeta}>{item.path}</span>
                        </div>
                      ) : (
                        <button
                          key={`fs:${item.filesystemKind}:${item.path}`}
                          type="button"
                          role="option"
                          aria-selected={false}
                          className={styles.searchResultRow}
                          title={item.path}
                          onClick={() => handleFileResultClick(item)}
                        >
                          <span className={styles.searchResultKind}>File</span>
                          <span className={styles.searchResultLabel}>{item.name}</span>
                          <span className={styles.searchResultMeta}>{item.path}</span>
                        </button>
                      )
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
    </div>
  );
}
