import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from 'react';
import {
  parsePalettePrefix,
  entryFilterFromText,
  keepTables,
  planPaletteSearch,
  type LibraryTreeChild,
  type PaletteAugmentedResponse,
  type PaletteEntryHit,
  type PaletteNodeKind,
  type PaletteSearchHit,
  type PaletteFileNodeItem,
  type PaletteFilesystemItem,
  type FileTreeNode,
} from '../../utils/api';
import { mergePaletteHits, stableMergeById, useTieredSearch } from '@desktop/hooks/useTieredSearch';
import { usePointerMoveGate, type PointerSpot } from '@desktop/hooks/usePointerMoveGate';
import {
  DEFAULT_SEARCH_CHANNELS,
  type SearchChannels,
} from '@desktop/components/SearchModeControl';

/** Most node hits the dropdown lists. */
const MAX_RESULTS = 8;

/** file:/folder: filter — not a workspace node kind. */
export type TreeFsFilter = 'file' | 'folder';
import type { WorkspaceTreeProps } from './types';
import { getPaletteHitLabel, viewForHitKind } from './searchUtils';

/** Flatten per-kind buckets into one score-sorted list. */
function flattenSearchHits(response: PaletteAugmentedResponse | null): PaletteSearchHit[] {
  if (!response) return [];
  return Object.values(response.byKind ?? {})
    .filter((bucket): bucket is PaletteSearchHit[] => Array.isArray(bucket))
    .flat()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** How a picked table row opens: in its own window, or highlighted in its table. */
type TreeEntryOpen = 'window' | 'highlight';

interface UseWorkspaceTreeSearchParams {
  onNodeClick?: WorkspaceTreeProps['onNodeClick'];
  /** Opens a table row (its table's catalog id and the row's UUID), as the command palette does. */
  onOpenEntry?: (tableId: string, entryId: string, how: TreeEntryOpen) => void;
  /** Opens a table's pane (its catalog id). A picked table hit is revealed in the tree's Tables group and opened here. */
  onOpenTable?: (tableId: string) => void;
  onCrossViewReveal?: WorkspaceTreeProps['onCrossViewReveal'];
  onLibraryHit?: WorkspaceTreeProps['onLibraryHit'];
  nodeIndexRef: MutableRefObject<Map<string, LibraryTreeChild>>;
  pendingOpenIdRef: MutableRefObject<string | null>;
}

export function useWorkspaceTreeSearch({
  onNodeClick,
  onOpenEntry,
  onOpenTable,
  onCrossViewReveal,
  onLibraryHit,
  nodeIndexRef,
  pendingOpenIdRef,
}: UseWorkspaceTreeSearchParams) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchChannels, setSearchChannels] = useState<SearchChannels>(DEFAULT_SEARCH_CHANNELS);
  // Active `prefix:` filter chips (e.g. `docs:` -> doc). Mirrors the command
  // palette: typing a recognized prefix converts it into a kind filter chip
  // and the search is scoped to those kinds. Backspace on an empty input pops
  // the last chip.
  const [searchFilterKinds, setSearchFilterKinds] = useState<PaletteNodeKind[]>([]);
  // file:/folder: filter (separate from node-kind chips).
  const [fsFilter, setFsFilter] = useState<TreeFsFilter | null>(null);
  // `entry:` chip: search table rows only (the palette's `entry:` search, which also finds rows by meaning).
  const [entryFilter, setEntryFilter] = useState(false);
  // `table:<name>:entry:` — the one table whose rows the `entry:` chip searches.
  const [entryTable, setEntryTable] = useState<string | null>(null);
  // Internal reveal trigger — set when a search result is clicked. The reveal
  // effect in WorkspaceTree honors this over the `revealNodeId` prop so
  // search always wins.
  const [searchRevealId, setSearchRevealId] = useState<string | null>(null);
  const [searchRevealNonce, setSearchRevealNonce] = useState(0);
  // Keyboard-active result in the dropdown. The closest match auto-selects to 0
  // whenever results change; Up/Down move it, Enter fires the active row.
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  // Hover moves it too, but only a pointer that really moves: rows that appear
  // under a resting pointer must not take Enter from the closest match.
  const pointer = usePointerMoveGate();
  const hoverSearchRow = useCallback(
    (index: number, event: PointerSpot) => {
      if (pointer.moved(event)) setSearchActiveIndex(index);
    },
    [pointer]
  );

  // Keyword-first inline search. The instant (keyword) tier renders on every
  // keystroke; the debounced hybrid tier adds semantic hits below without
  // reordering the keyword hits. file:/folder: routes to the server as a query
  // prefix (the palette route parses it); node-kind chips are dropped so only
  // file/filesystem results come back.
  const trimmedQuery = searchQuery.trim();
  const searchEnabled =
    trimmedQuery.length > 0 || searchFilterKinds.length > 0 || fsFilter !== null || entryFilter;
  const plan = planPaletteSearch({
    term: trimmedQuery,
    kinds: searchFilterKinds,
    fsFilter,
    entryFilter: entryFilter ? { table: entryTable } : null,
    // Table rows sit beside the nodes unless the search is scoped to a kind or the filesystem.
    allowEntries: Boolean(onOpenEntry),
  });
  const serverQuery = plan.query;
  const searchKinds = plan.kinds;

  const { instant, enriched, instantLoading, enrichmentLoading } = useTieredSearch({
    query: serverQuery,
    enabled: searchEnabled,
    kinds: searchKinds,
    perKindLimit: 5,
    channels: searchChannels,
    includeEntries: plan.includeEntries,
  });
  const searchLoading = instantLoading || enrichmentLoading;
  const refined = enriched;

  // Merge stably (keyword positions held, semantic-only appended) and cap the
  // dropdown to a compact list.
  const searchResults = useMemo<PaletteSearchHit[]>(() => {
    if (entryFilter) return [];
    const all = mergePaletteHits(flattenSearchHits(instant), flattenSearchHits(refined));
    // Keep a couple of table hits when other kinds fill the list: a table is a
    // destination of its own (a catalog id, not a node) and would be cut first.
    return keepTables(all, (hit) => hit.kind === 'table', MAX_RESULTS);
  }, [instant, refined, entryFilter]);
  // Table rows ("entries"): keyword rows first, rows found by meaning appended, a few at most.
  const entryResults = useMemo<PaletteEntryHit[]>(
    () =>
      stableMergeById(
        instant?.entries ?? [],
        refined?.entries ?? [],
        (hit) => `${hit.tableId}/${hit.entryId}`
      ).slice(0, plan.rowLimit ?? MAX_RESULTS),
    [instant, refined, plan.rowLimit]
  );
  // File nodes are semantic-only, so they arrive with the hybrid enrichment.
  const fileResults = useMemo<PaletteFileNodeItem[]>(
    () => refined?.files ?? instant?.files ?? [],
    [instant, refined]
  );
  const filesystemResults = useMemo<PaletteFilesystemItem[]>(
    () =>
      stableMergeById(instant?.filesystem ?? [], refined?.filesystem ?? [], (item) => item.path),
    [instant, refined]
  );

  // Reset the selection, and where the pointer rests, whenever the dropdown
  // opens or the query/filter changes.
  useEffect(() => {
    setSearchActiveIndex(0);
    pointer.reset();
  }, [searchOpen, searchQuery, fsFilter, searchFilterKinds, entryFilter, entryTable, pointer]);

  // Click a search result → reveal it in the tree (expand ancestors + scroll +
  // pulse) and collapse the search dropdown. Bumping the nonce re-fires the
  // reveal effect even if the same node is clicked twice.
  const handleSearchResultClick = useCallback(
    (hit: PaletteSearchHit) => {
      // A table is revealed in the tree's own Tables group (expanded, scrolled to and
      // pulsed like a node) and opened in the pane.
      if (hit.kind === 'table' && onOpenTable) {
        setSearchRevealId(hit.node_id);
        setSearchRevealNonce((n) => n + 1);
        onOpenTable(hit.node_id);
        setSearchOpen(false);
        setSearchQuery(getPaletteHitLabel(hit));
        return;
      }
      const targetView = viewForHitKind(hit.kind);
      if (targetView && onCrossViewReveal) {
        onCrossViewReveal(targetView, hit);
        setSearchOpen(false);
        setSearchQuery(getPaletteHitLabel(hit));
        return;
      }

      onLibraryHit?.(hit);
      setSearchRevealId(hit.node_id);
      setSearchRevealNonce((n) => n + 1);

      const node = nodeIndexRef.current.get(hit.node_id);
      if (node) {
        pendingOpenIdRef.current = null;
        onNodeClick?.(node);
      } else {
        pendingOpenIdRef.current = hit.node_id;
      }

      setSearchOpen(false);
      setSearchQuery(getPaletteHitLabel(hit));
    },
    [onNodeClick, onCrossViewReveal, onLibraryHit, onOpenTable, nodeIndexRef, pendingOpenIdRef]
  );

  // A table row opens the way a picked row does in the command palette: its own
  // window, or (⌘/Ctrl-click, ⌘/Ctrl+Enter) highlighted in its table.
  const handleEntryResultClick = useCallback(
    (hit: PaletteEntryHit, options: { secondary?: boolean } = {}) => {
      onOpenEntry?.(hit.tableId, hit.entryId, options.secondary ? 'highlight' : 'window');
      // Show where the row lives: its table in the tree's Tables group.
      setSearchRevealId(hit.tableId);
      setSearchRevealNonce((n) => n + 1);
      setSearchOpen(false);
      setSearchQuery(hit.name || hit.tableName);
    },
    [onOpenEntry]
  );

  // File / filesystem search hits open the file preview pane. Mirrors the
  // command palette's onOpenFile mapping (Dashboard.tsx) so both surfaces
  // build the same FileTreeNode shape.
  const handleFileResultClick = useCallback(
    (file: PaletteFileNodeItem | PaletteFilesystemItem) => {
      const node: FileTreeNode =
        file.type === 'file-node'
          ? {
              kind: 'file',
              id: file.nodeId,
              containerId: null,
              projectId: file.projectId,
              relativePath: file.relativePath,
              name: file.relativePath.split('/').pop() ?? file.relativePath,
              sizeBytes: file.sizeBytes,
              updatedAt: file.updatedAt,
            }
          : {
              kind: 'file',
              id: file.path,
              containerId: null,
              projectId: '',
              relativePath: file.name,
              name: file.name,
              sizeBytes: 0,
              updatedAt: new Date().toISOString(),
            };
      onNodeClick?.(node);
      setSearchOpen(false);
      setSearchQuery('');
    },
    [onNodeClick]
  );

  // Input change. If the user types a recognized `prefix:` pattern (e.g.
  // `docs:`), convert it into a filter chip and strip the prefix from the
  // text — mirrors the command palette syntax via the shared
  // PREFIX_FILTER_META map.
  const handleSearchChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      // `entry:`, `table:work_items:entry:query` (typed whole or after a `table:` chip): rows.
      const entryText = entryFilterFromText(value, searchFilterKinds.includes('table'));
      if (entryText) {
        setSearchFilterKinds((prev) => prev.filter((kind) => kind !== 'table'));
        setEntryFilter(true);
        setEntryTable(entryText.filter.table);
        setSearchQuery(entryText.remainder);
        setSearchOpen(true);
        return;
      }
      const match = value.match(/^([a-z][a-z0-9_]*):\s*/i);
      if (match) {
        const prefix = match[1].toLowerCase();
        // file:/folder: aren't node kinds — they set the fs filter.
        if (prefix === 'file' || prefix === 'folder') {
          setFsFilter(prefix);
          setSearchQuery(value.slice(match[0].length));
          setSearchOpen(true);
          return;
        }
        const parsed = parsePalettePrefix(`${prefix}:`);
        if (parsed && parsed.kind !== 'file' && parsed.kind !== 'folder') {
          const kind = parsed.kind as PaletteNodeKind;
          setSearchFilterKinds((prev) => (prev.includes(kind) ? prev : [...prev, kind]));
          setSearchQuery(value.slice(match[0].length));
          setSearchOpen(true);
          return;
        }
      }
      setSearchQuery(value);
      setSearchOpen(true);
    },
    [searchFilterKinds]
  );

  // Backspace on an empty input pops the most-recent filter chip.
  const handleSearchKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        setSearchQuery('');
        setSearchFilterKinds([]);
        setFsFilter(null);
        setEntryFilter(false);
        setEntryTable(null);
        setSearchOpen(false);
        return;
      }
      // The list is the node hits, then the table rows.
      const total = searchResults.length + entryResults.length;
      if (e.key === 'ArrowDown' && total > 0) {
        e.preventDefault();
        setSearchActiveIndex((i) => (i + 1) % total);
        return;
      }
      if (e.key === 'ArrowUp' && total > 0) {
        e.preventDefault();
        setSearchActiveIndex((i) => (i - 1 + total) % total);
        return;
      }
      if (e.key === 'Enter' && total > 0) {
        e.preventDefault();
        const entry = entryResults[searchActiveIndex - searchResults.length];
        if (entry) {
          handleEntryResultClick(entry, { secondary: e.metaKey || e.ctrlKey });
          return;
        }
        const hit = searchResults[searchActiveIndex] ?? searchResults[0];
        if (hit) handleSearchResultClick(hit);
        else if (entryResults[0]) handleEntryResultClick(entryResults[0]);
        return;
      }
      if (
        e.key === 'Backspace' &&
        searchQuery.length === 0 &&
        (searchFilterKinds.length > 0 || fsFilter || entryFilter)
      ) {
        e.preventDefault();
        if (entryFilter) {
          setEntryFilter(false);
          setEntryTable(null);
        } else if (fsFilter) setFsFilter(null);
        else setSearchFilterKinds((prev) => prev.slice(0, -1));
      }
    },
    [
      searchQuery,
      searchFilterKinds,
      fsFilter,
      entryFilter,
      searchResults,
      entryResults,
      searchActiveIndex,
      handleSearchResultClick,
      handleEntryResultClick,
    ]
  );

  const removeSearchFilterKind = useCallback((kind: PaletteNodeKind) => {
    setSearchFilterKinds((prev) => prev.filter((k) => k !== kind));
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchFilterKinds([]);
    setFsFilter(null);
    setEntryFilter(false);
    setEntryTable(null);
    setSearchOpen(false);
  }, []);

  const removeFsFilter = useCallback(() => setFsFilter(null), []);
  const removeEntryFilter = useCallback(() => {
    setEntryFilter(false);
    setEntryTable(null);
  }, []);

  return {
    clearSearch,
    handleSearchChange,
    handleSearchKeyDown,
    handleSearchResultClick,
    handleFileResultClick,
    handleEntryResultClick,
    hitLabel: getPaletteHitLabel,
    removeSearchFilterKind,
    removeFsFilter,
    removeEntryFilter,
    fsFilter,
    entryFilter,
    entryTable,
    fileResults,
    filesystemResults,
    entryResults,
    hoverSearchRow,
    searchActiveIndex,
    searchChannels,
    searchFilterKinds,
    searchLoading,
    searchOpen,
    searchQuery,
    searchResults,
    searchRevealId,
    searchRevealNonce,
    setSearchActiveIndex,
    setSearchChannels,
    setSearchOpen,
  };
}
