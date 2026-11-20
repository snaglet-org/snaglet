import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { usePointerMoveGate } from '@desktop/hooks/usePointerMoveGate';
import {
  PALETTE_NODE_KINDS,
  PREFIX_FILTER_META,
  parsePalettePrefix,
  type LibraryTreeChild,
  type PaletteCoverageMode,
  type PaletteFileNodeItem,
  type PaletteFilesystemItem,
  type ThreadTreeNode,
  type ToolRow,
} from '@desktop/utils/api';
import { type SnagletAgent, type TableCatalogEntry } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { shortcutHint } from '@desktop/utils/platform';
import { hydrateSearchResultNode, useQuickSearch, type FsFilter } from './useQuickSearch';
import { type Kind, type SearchResult } from './paletteResultMappers';
import {
  Button,
  DEFAULT_SEARCH_CHANNELS,
  SearchModeControl,
  type SearchChannels,
} from '@desktop/components';
import { Chip } from '@desktop/components/Chip';
import { focusableElements } from '@desktop/components/Modal/Modal';
import { KindIcon } from './KindIcon';
import {
  COVERAGE_LABELS,
  FOOTER_FILTERS,
  kindMeta,
  semanticEmptyState,
  type FooterFilterEntry,
} from './paletteDisplay';
import { openPaletteResult, type PaletteEntryOpen } from './paletteActions';
import { entryFilterFromText, type EntryFilter } from '@desktop/utils/api/searchPlan';
import { PaletteResultsList } from './PaletteResultsList';
import styles from './CommandPalette.module.scss';

interface CommandPaletteProps {
  open: boolean;
  activeNodeId?: string | null;
  onClose: () => void;
  onSelect: (node: LibraryTreeChild) => void;
  onOpenThreadAgent: (
    thread: ThreadTreeNode,
    agentId: string,
    opts?: { focus?: { kind: 'memory' | 'summary'; id: string } }
  ) => void;
  /**
   * Open a thread focused on a specific message — chat loads a window
   * centered on `messageId` and scrolls + flashes that row. Used by
   * message hits.
   */
  onOpenThreadWithFocusMessage: (thread: ThreadTreeNode, messageId: string) => void;
  onOpenTool: (tool: ToolRow) => void;
  onOpenAgent: (agent: SnagletAgent) => void;
  /** Open a Database table pane by catalog id. */
  onOpenTable?: (tableId: string, table?: TableCatalogEntry) => void;
  /**
   * Open a table row: its window over its table (`window`, a plain pick), or
   * its table with the row highlighted (`highlight`, a ⌘/Ctrl pick).
   */
  onOpenEntry?: (tableId: string, entryId: string, how: PaletteEntryOpen) => void;
  onOpenFile: (file: PaletteFileNodeItem | PaletteFilesystemItem) => void;
}

export const CommandPalette: FC<CommandPaletteProps> = ({
  open,
  activeNodeId,
  onClose,
  onSelect,
  onOpenThreadAgent,
  onOpenThreadWithFocusMessage,
  onOpenTool,
  onOpenAgent,
  onOpenTable,
  onOpenEntry,
  onOpenFile,
}) => {
  // `term` is the raw text in the input; `filterKinds` is the array of active
  // kind chips (can have multiple, e.g. ['task', 'project']).
  const [term, setTerm] = useState('');
  const [filterKinds, setFilterKinds] = useState<Kind[]>([]);
  // The highlighted row's key. It pins the row the user moved to (arrow keys
  // or a real pointer move), so results that arrive later (keyword, then
  // semantic) and shift the list keep it highlighted; null, or a row that is
  // gone, means the first result, as after typing.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Only a pointer that really moves may highlight a row: rows that appear
  // under a resting pointer must not steal Enter from the top result.
  const pointer = usePointerMoveGate();
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const coverageTooltipId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const {
    results,
    sections,
    fileResults,
    filesystemResults,
    loading,
    lexicalLoading,
    serverLoading,
    semanticStatus,
    semanticStatusReason,
    coverage,
    search,
    invalidate,
    executionPlan,
  } = useQuickSearch(activeNodeId);
  // file:/folder: filter — not a workspace node kind, tracked separately from
  // the kind chips and routed to the server as a query prefix.
  const [fsFilter, setFsFilter] = useState<FsFilter | null>(null);
  // entry: filter — table rows only, optionally within one named table. Like
  // the fs filter it stands alone: choosing it clears the kind chips, and a
  // kind chip or file: clears it.
  const [entryFilter, setEntryFilter] = useState<EntryFilter | null>(null);
  const [searchChannels, setSearchChannels] = useState<SearchChannels>(DEFAULT_SEARCH_CHANNELS);
  // Set when a picked result could not be opened (its record failed to load);
  // the palette stays open and says so instead of closing on nothing.
  const [openError, setOpenError] = useState<string | null>(null);

  /** Return focus to the input after a chip click, once the click settles. */
  const focusInputSoon = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  /** Add a kind to the filter chips (no-op if already present). */
  const addKind = useCallback((kind: Kind) => {
    setFilterKinds((prev) => (prev.includes(kind) ? prev : [...prev, kind]));
    setEntryFilter(null);
  }, []);

  /** Remove a kind from the filter chips. */
  const removeKind = useCallback(
    (kind: Kind) => {
      setFilterKinds((prev) => prev.filter((k) => k !== kind));
      focusInputSoon();
    },
    [focusInputSoon]
  );

  /**
   * Handle input changes. If the user types a recognized `prefix:` pattern,
   * automatically convert it into a filter chip and clear the typed prefix.
   */
  const handleTermChange = useCallback(
    (typed: string) => {
      // The space after `entry:` lands once the chip has taken the prefix;
      // keep it out of the otherwise empty input.
      const newTerm = entryFilter && term === '' ? typed.trimStart() : typed;
      // `entry:`, `table:<name> entry:`, or `<name> entry:` after a Table chip
      // turn on the entry filter (all tables, or the named one).
      const entry = entryFilterFromText(newTerm, filterKinds.includes('table'));
      if (entry) {
        setEntryFilter(entry.filter);
        setFilterKinds([]);
        setFsFilter(null);
        setTerm(entry.remainder);
        return;
      }
      // Detect trailing `word:` — e.g. user typed "task:"
      const parsed = parsePalettePrefix(newTerm);
      if (parsed) {
        const prefix = parsed.prefix;
        // file:/folder: aren't workspace node kinds — they set the fs filter.
        if (prefix === 'file' || prefix === 'folder') {
          setFsFilter(prefix);
          setEntryFilter(null);
          setTerm(parsed.remainder);
          return;
        }
        if (parsed.kind !== 'file' && parsed.kind !== 'folder') {
          addKind(parsed.kind);
          setTerm(parsed.remainder); // keep any text after the colon
          return;
        }
      }
      setTerm(newTerm);
    },
    [addKind, entryFilter, filterKinds, term]
  );

  // Derived: kinds array passed to search (null = no filter)
  const activeKinds = useMemo(() => (filterKinds.length > 0 ? filterKinds : null), [filterKinds]);

  // Navigable rows in order: node results, then file-node rows, then
  // filesystem rows. Node rows keep their indices (0..results.length-1); file
  // and filesystem rows are appended so resultIndexById stays valid.
  const navKeys = useMemo(
    () => [
      ...results.map((hit) => `node:${hit.node.id}`),
      ...fileResults.map((file) => `file:${file.nodeId}`),
      ...filesystemResults.map((item) => `fs:${item.path}`),
    ],
    [results, fileResults, filesystemResults]
  );
  const total = navKeys.length;
  const activeIdx = activeKey === null ? 0 : Math.max(navKeys.indexOf(activeKey), 0);
  const setActiveIdx = (index: number) => setActiveKey(navKeys[index] ?? null);
  const hoverRow = (index: number, event: ReactMouseEvent) => {
    if (pointer.moved(event) && index !== activeIdx) setActiveIdx(index);
  };

  // Reset + focus when palette opens.
  useEffect(() => {
    if (!open) return;
    setTerm('');
    setFilterKinds([]);
    setFsFilter(null);
    setEntryFilter(null);
    setActiveKey(null);
    pointer.reset();
    invalidate(); // always pick up tree changes
    // Defer focus one tick so the element is visible.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, invalidate, pointer]);

  // Hand focus back to where it was (the chat composer, an editor) when the
  // palette closes. A pick that opens something new may already have moved
  // focus into it, and an element its pane replaced is gone — both win.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!previous || previous === document.body) return;
    return () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        const focusIsFree = !active || active === document.body || !active.isConnected;
        if (focusIsFree && previous.isConnected) previous.focus({ preventScroll: true });
      }, 0);
    };
  }, [open]);

  // Re-run search whenever term or filter kinds change.
  useEffect(() => {
    void search(term, activeKinds, fsFilter, searchChannels, entryFilter);
    setActiveKey(null);
    pointer.reset();
    setOpenError(null);
  }, [term, activeKinds, fsFilter, searchChannels, entryFilter, search, pointer]);

  // Scroll active result into view.
  useEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>(`[data-result-index="${activeIdx}"]`);
    item?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIdx]);

  // Escape closes the palette from anywhere inside it (the input, a filter
  // chip, a search-method checkbox) unless a nested control claimed it first.
  // Tab and Shift+Tab wrap inside the dialog, as in Modal, so focus never
  // moves to the app hidden behind it.
  const handlePanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    const panel = panelRef.current;
    if (e.key !== 'Tab' || !panel) return;
    const focusable = focusableElements(panel);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const current = document.activeElement;
    if (e.shiftKey && (current === first || !panel.contains(current))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (current === last || !panel.contains(current))) {
      e.preventDefault();
      first.focus();
    }
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // Backspace on empty term removes the last filter chip (an entry
    // filter's table first, then the filter).
    if (
      e.key === 'Backspace' &&
      term === '' &&
      (filterKinds.length > 0 || fsFilter || entryFilter)
    ) {
      e.preventDefault();
      if (entryFilter?.table) setEntryFilter({ table: null });
      else if (entryFilter) setEntryFilter(null);
      else if (fsFilter) setFsFilter(null);
      else setFilterKinds((prev) => prev.slice(0, -1));
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(Math.max(Math.min(activeIdx + 1, total - 1), 0));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(Math.max(activeIdx - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // ⌘/Ctrl+Enter is the secondary open (a table row in its table).
      pickByIndex(activeIdx, e.metaKey || e.ctrlKey);
      return;
    }
  };

  const pickResult = async (hit: SearchResult, secondary = false) => {
    try {
      await openPaletteResult(
        await hydrateSearchResultNode(hit),
        {
          onSelect,
          onOpenThreadAgent,
          onOpenThreadWithFocusMessage,
          onOpenTool,
          onOpenAgent,
          onOpenTable,
          onOpenEntry,
        },
        { secondary }
      );
    } catch (err) {
      console.error('CommandPalette: failed to open a result', getErrorMessage(err));
      setOpenError(`Couldn't open ${hit.label}. Try again.`);
      return;
    }
    onClose();
  };

  // Resolve a unified nav index to its bucket.
  const pickByIndex = (idx: number, secondary = false) => {
    if (idx < results.length) {
      const hit = results[idx];
      if (hit) void pickResult(hit, secondary);
      return;
    }
    const fileOffset = idx - results.length;
    if (fileOffset < fileResults.length) {
      const fileItem = fileResults[fileOffset];
      if (fileItem) {
        onOpenFile(fileItem);
        onClose();
      }
      return;
    }
    const fsItem = filesystemResults[fileOffset - fileResults.length];
    if (fsItem) {
      onOpenFile(fsItem);
      onClose();
    }
  };

  const resultIndexById = useMemo(
    () => new Map(results.map((hit, index) => [hit.node.id, index] as const)),
    [results]
  );
  const resultKindCount = new Set(results.map((hit) => hit.node.kind)).size;
  const resultAnnouncement = `${total} result${total === 1 ? '' : 's'} across ${resultKindCount} kind${resultKindCount === 1 ? '' : 's'}`;
  const coverageEntries = PALETTE_NODE_KINDS.flatMap((kind) => {
    const mode = coverage[kind];
    return mode ? [{ kind, mode }] : [];
  });
  const coverageSummary = (Object.keys(COVERAGE_LABELS) as PaletteCoverageMode[])
    .flatMap((mode) => {
      const count = coverageEntries.filter((entry) => entry.mode === mode).length;
      return count > 0 ? [`${COVERAGE_LABELS[mode]}: ${count}`] : [];
    })
    .join(' · ');
  // A scope the server could not apply outranks every other empty-state
  // message. There are no results because the search never ran, and saying
  // anything else here — or nothing — makes a refused scope look like a
  // workspace that simply contains no matches.
  const scopeError = executionPlan?.scopeError ?? null;
  const semanticEmpty = scopeError
    ? { message: scopeError.message }
    : term.trim()
      ? semanticEmptyState(semanticStatus, semanticStatusReason)
      : null;

  // Is there anything to show in the results panel?
  const hasQuery =
    term.trim().length > 0 || filterKinds.length > 0 || fsFilter !== null || entryFilter !== null;
  const hasEntryResults = results.some((hit) => hit.node.kind === 'entry');

  // Input placeholder reflects the active kind filter: a single chip names
  // the kind, multiple chips fall back to a generic prompt, none lists examples.
  let inputPlaceholder = 'Search docs, threads, agents, tasks…';
  if (entryFilter) {
    inputPlaceholder = entryFilter.table
      ? `Search entries in ${entryFilter.table}…`
      : `Search ${kindMeta('entry').plural}…`;
  } else if (filterKinds.length === 1) {
    inputPlaceholder = `Search ${kindMeta(filterKinds[0]).plural}…`;
  } else if (fsFilter === 'file') {
    inputPlaceholder = 'Search files…';
  } else if (fsFilter === 'folder') {
    inputPlaceholder = 'Search folders…';
  } else if (filterKinds.length > 1) {
    inputPlaceholder = 'Search…';
  }

  if (!open) return null;

  return (
    <div className={styles.backdrop} onMouseDown={onClose} role="presentation">
      {/* Stop mousedown propagation so clicking inside doesn't close */}
      <div
        ref={panelRef}
        className={styles.panel}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handlePanelKeyDown}
        role="dialog"
        aria-modal
        aria-label="Quick search"
      >
        <div className={styles.inputRow}>
          <span className={styles.searchGlyph} aria-hidden>
            ⌕
          </span>
          {/* Active filter chips */}
          {filterKinds.map((kind) => (
            <Chip
              key={kind}
              size="sm"
              tone={kindMeta(kind).tone}
              icon={<KindIcon kind={kind} />}
              onRemove={() => removeKind(kind)}
              removeLabel={`Remove ${kindMeta(kind).label} filter`}
            >
              {kindMeta(kind).label}
            </Chip>
          ))}
          {fsFilter && (
            <Chip
              size="sm"
              tone="primary"
              onRemove={() => {
                setFsFilter(null);
                focusInputSoon();
              }}
              removeLabel={`Remove ${fsFilter} filter`}
            >
              {fsFilter === 'folder' ? 'Folder' : 'File'}
            </Chip>
          )}
          {entryFilter && (
            <Chip
              size="sm"
              tone={kindMeta('entry').tone}
              icon={<KindIcon kind="entry" />}
              onRemove={() => {
                setEntryFilter(null);
                focusInputSoon();
              }}
              removeLabel="Remove Entry filter"
            >
              {kindMeta('entry').label}
            </Chip>
          )}
          {entryFilter?.table && (
            <Chip
              size="sm"
              tone={kindMeta('table').tone}
              icon={<KindIcon kind="table" />}
              onRemove={() => {
                setEntryFilter({ table: null });
                focusInputSoon();
              }}
              removeLabel={`Search entries in every table, not only ${entryFilter.table}`}
            >
              {entryFilter.table}
            </Chip>
          )}
          <input
            ref={inputRef}
            className={styles.input}
            value={term}
            onChange={(e) => handleTermChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={inputPlaceholder}
            aria-label="Quick search"
            autoComplete="off"
            spellCheck={false}
          />
          {(term || filterKinds.length > 0 || fsFilter || entryFilter) && (
            <Button
              variant="neutral"
              size="sm"
              iconOnly
              aria-label="Clear search"
              onClick={() => {
                setTerm('');
                setFilterKinds([]);
                setFsFilter(null);
                setEntryFilter(null);
                inputRef.current?.focus();
              }}
            >
              ×
            </Button>
          )}
        </div>

        <div className={styles.filterBar}>
          <SearchModeControl
            value={searchChannels}
            onChange={setSearchChannels}
            context="quick search"
          />
          {executionPlan &&
            (executionPlan.scopeLabel ||
              executionPlan.timeLabel ||
              executionPlan.ordering !== 'relevance') && (
              <span className={styles.inferredConstraints} aria-label="Inferred search constraints">
                {executionPlan.scopeLabel && <span>Scope: {executionPlan.scopeLabel}</span>}
                {executionPlan.timeLabel && <span>Time: {executionPlan.timeLabel}</span>}
                {executionPlan.ordering === 'updated_desc' && <span>Newest updated</span>}
                {executionPlan.ordering === 'created_desc' && <span>Newest created</span>}
              </span>
            )}
          <span className={styles.kindFilters} aria-label="Result type filters">
            {FOOTER_FILTERS.map((p): FooterFilterEntry | null => {
              if (p === 'file' || p === 'entry') return { p, meta: null };
              const meta = PREFIX_FILTER_META[p];
              return meta ? { p, meta } : null;
            })
              .filter((entry): entry is FooterFilterEntry => entry !== null)
              .map(({ p, meta }) => {
                const active = meta
                  ? filterKinds.includes(meta.kind)
                  : p === 'entry'
                    ? entryFilter !== null
                    : fsFilter === 'file';
                return (
                  <Chip
                    key={p}
                    size="xs"
                    tone="primary"
                    aria-pressed={active}
                    tabIndex={0}
                    onMouseDown={(e) => {
                      e.preventDefault();
                    }}
                    onClick={() => {
                      if (!meta && p === 'entry') {
                        setEntryFilter(active ? null : { table: null });
                        setFilterKinds([]);
                        setFsFilter(null);
                        focusInputSoon();
                      } else if (!meta) {
                        setFsFilter(active ? null : 'file');
                        setFilterKinds([]);
                        setEntryFilter(null);
                        focusInputSoon();
                      } else if (active) {
                        removeKind(meta.kind);
                      } else {
                        addKind(meta.kind);
                        setFsFilter(null);
                        focusInputSoon();
                      }
                    }}
                  >
                    {p}:
                  </Chip>
                );
              })}
          </span>
        </div>

        {hasQuery && (
          <PaletteResultsList
            listRef={listRef}
            loading={loading}
            lexicalLoading={lexicalLoading}
            serverLoading={serverLoading}
            total={total}
            term={term}
            openError={openError}
            semanticEmpty={semanticEmpty}
            sections={sections}
            resultIndexById={resultIndexById}
            resultsLength={results.length}
            fileResults={fileResults}
            filesystemResults={filesystemResults}
            activeIdx={activeIdx}
            onRowPointerMove={hoverRow}
            pickResult={pickResult}
            pickByIndex={pickByIndex}
          />
        )}
        <span className={styles.srOnly} role="status" aria-live="polite">
          {openError ?? (hasQuery ? resultAnnouncement : '')}
        </span>

        <div className={styles.footer}>
          <span>
            <kbd>↑↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          {hasEntryResults && (
            <span>
              <kbd>{shortcutHint('↵')}</kbd> show row in table
            </span>
          )}
          <span>
            <kbd>Esc</kbd> close
          </span>
          {/* Which engine covered each kind: a development aid, not for people. */}
          {import.meta.env.DEV && coverageEntries.length > 0 && (
            <span className={styles.coverageWrap}>
              <span
                className={styles.coverageBadge}
                tabIndex={0}
                aria-describedby={coverageTooltipId}
              >
                {coverageSummary}
              </span>
              <span id={coverageTooltipId} className={styles.coveragePopover} role="tooltip">
                {coverageEntries.map(({ kind, mode }) => (
                  <span key={kind} className={styles.coverageRow}>
                    <span>{kindMeta(kind).label}</span>
                    <strong>{COVERAGE_LABELS[mode]}</strong>
                  </span>
                ))}
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
