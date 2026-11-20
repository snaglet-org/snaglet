import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  PREFIX_FILTER_META,
  parsePalettePrefix,
  type PaletteAugmentedResponse,
  type PaletteEntryHit,
  type PaletteFileNodeItem,
  type PaletteFilesystemItem,
  type PaletteSearchKind,
  type PaletteWorkspaceItem,
} from '@desktop/utils/api/palette-search';
import { entryFilterFromText, planPaletteSearch } from '@desktop/utils/api/searchPlan';
import { PALETTE_NODE_KINDS, type PaletteNodeKind } from '@snaglet/shared';
import { formatBytes } from '@snaglet/shared/utils';
import { stableMergeById, useTieredSearch } from '@desktop/hooks/useTieredSearch';
import { usePointerMoveGate } from '@desktop/hooks/usePointerMoveGate';
import {
  EditorPopover,
  EditorPopoverHeader,
  editorPopoverStyles as popoverStyles,
} from './EditorPopover';

export type NodeMentionAnchor = Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'> | null;

export type AgentMentionHit = {
  type: 'agent';
  key: string;
  label: string;
  subtitle: string | null;
  agent: {
    id: string;
    name: string | null;
    handle: string | null;
    role: string | null;
  };
  prefix: boolean;
};

type WorkspaceMentionHit = {
  type: 'workspace';
  key: string;
  label: string;
  subtitle: string | null;
  workspace: PaletteWorkspaceItem;
};

type FilesystemMentionHit = {
  type: 'filesystem';
  key: string;
  label: string;
  subtitle: string | null;
  filesystem: PaletteFilesystemItem;
};

type FileNodeMentionHit = {
  type: 'file-node';
  key: string;
  label: string;
  subtitle: string | null;
  file: PaletteFileNodeItem;
};

export type TriggerMentionHit = {
  type: 'trigger';
  key: string;
  label: string;
  subtitle: string | null;
  trigger: string;
};

/** A table row, picked from the same search as the nodes (`entry:` scopes the search to rows). */
type EntryMentionHit = {
  type: 'entry';
  key: string;
  label: string;
  subtitle: string | null;
  entry: PaletteEntryHit;
};

export type NodeMentionHit =
  | AgentMentionHit
  | EntryMentionHit
  | WorkspaceMentionHit
  | FilesystemMentionHit
  | FileNodeMentionHit
  | TriggerMentionHit;

export type MentionTriggerOption = {
  value: string;
  label: string;
};

type MentionFilterKind =
  | PaletteNodeKind
  | 'agent'
  | 'file'
  | 'folder'
  | 'node'
  | 'trigger'
  | 'entry';

/** `entry:` (or `entries:`, `row:`, `rows:`) scopes the search to table rows. */
const ENTRY_FILTER_PREFIXES = new Set(['entry', 'entries', 'row', 'rows']);

type ParsedMentionQuery = {
  query: string;
  filters: MentionFilterKind[];
  /** `table:<name>:entry:` — the one table whose rows are searched. */
  table?: string;
};

type Props = {
  open: boolean;
  anchorRect: NodeMentionAnchor;
  query: string;
  threadId?: string;
  agentOptions?: AgentMentionHit[];
  /** The agent roster could not be loaded; says so where agents would list. */
  agentsUnavailable?: boolean;
  triggerOptions?: readonly MentionTriggerOption[];
  /** Restrict remote results to canonical Snaglet nodes/actors (no raw filesystem paths). */
  workspaceOnly?: boolean;
  /**
   * Offer only these kinds (a picker for one kind of thing, e.g. `['thread']`).
   * Agents come from `agentOptions` when `'agent'` is listed; the other kinds
   * are searched on the server. Typed `kind:` prefixes cannot widen it.
   */
  onlyKinds?: readonly PaletteNodeKind[];
  onSelect: (hit: NodeMentionHit) => void;
  onClose: () => void;
};

export type NodeMentionSearchHandle = {
  moveSelection: (delta: number) => void;
  confirmSelection: () => void;
  handleKeyDown?: (event: KeyboardEvent) => boolean;
};

type MentionResultSection = {
  key: string;
  label: string;
  items: Array<{ hit: NodeMentionHit; index: number }>;
};

export function agentChipTitle(hit: AgentMentionHit): string {
  return hit.agent.name || hit.agent.handle || 'Agent';
}

export function titleForMentionHit(hit: NodeMentionHit): string {
  if (hit.type === 'agent') return agentChipTitle(hit);
  if (hit.type === 'entry') return hit.entry.name || hit.entry.tableName;
  if (hit.type === 'trigger') return hit.label;
  if (hit.type === 'workspace') return hit.workspace.title;
  if (hit.type === 'file-node') return hit.file.relativePath;
  return hit.filesystem.path;
}

function parseMentionQuery(raw: string, allowTrigger: boolean): ParsedMentionQuery {
  const text = raw.trim();
  if (!text) return { query: '', filters: [] };
  const scoped = entryFilterFromText(text, false);
  if (scoped) {
    return {
      query: scoped.remainder,
      filters: ['entry'],
      ...(scoped.filter.table ? { table: scoped.filter.table } : {}),
    };
  }

  const filters: MentionFilterKind[] = [];
  let remainder = text;

  while (true) {
    const match = remainder.match(/^([a-z][a-z0-9_]*):/i);
    if (!match) break;
    const prefix = match[1].toLowerCase();
    const parsed = parsePalettePrefix(`${prefix}:`);
    const filter: MentionFilterKind | null = ENTRY_FILTER_PREFIXES.has(prefix)
      ? 'entry'
      : prefix === 'file' || prefix === 'folder' || prefix === 'node'
        ? prefix
        : prefix === 'trigger' && allowTrigger
          ? 'trigger'
          : parsed && parsed.kind !== 'file' && parsed.kind !== 'folder'
            ? parsed.kind
            : null;
    if (!filter) break;
    if (!filters.includes(filter)) filters.push(filter);
    remainder = remainder.slice(match[0].length).trimStart();
  }

  return { query: remainder, filters };
}

/**
 * Whether `text` holds every word of `query`, in any order and any case, so
 * a multi-word query narrows the list instead of emptying it (`clio res`
 * finds Clio, a researcher). A blank query holds nothing back.
 */
export function matchesEveryWord(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => !word || haystack.includes(word));
}

function workspaceKindsForFilters(filters: MentionFilterKind[]): PaletteNodeKind[] | null {
  const kinds = filters.filter(
    (filter): filter is PaletteNodeKind =>
      filter !== 'node' && PALETTE_NODE_KINDS.includes(filter as PaletteNodeKind)
  );
  return kinds.length > 0 ? kinds : null;
}

function searchKindsForFilters(filters: MentionFilterKind[]): PaletteSearchKind[] | null {
  const workspaceKinds = workspaceKindsForFilters(filters) ?? [];
  const filesystemKinds = filters.filter(
    (filter): filter is 'file' | 'folder' => filter === 'file' || filter === 'folder'
  );
  const kinds = [...workspaceKinds, ...filesystemKinds];
  return kinds.length > 0 ? kinds : null;
}

function hitLabel(hit: NodeMentionHit): string {
  if (hit.type === 'agent') return agentChipTitle(hit);
  if (hit.type === 'entry') return hit.entry.name || 'Untitled';
  if (hit.type === 'trigger') return hit.label;
  if (hit.type === 'workspace') return hit.workspace.title;
  if (hit.type === 'file-node') return hit.file.relativePath;
  return hit.filesystem.path;
}

function hitSubtitle(hit: NodeMentionHit): string | null {
  if (hit.type === 'entry') return hit.entry.tableName;
  if (hit.type === 'agent') {
    return ['Agent', hit.prefix ? 'prefix match' : null, hit.agent.role || null]
      .filter(Boolean)
      .join(' · ');
  }
  if (hit.type === 'workspace') {
    return hit.workspace.subtitle;
  }
  if (hit.type === 'trigger') return hit.subtitle;
  if (hit.type === 'file-node') {
    return ['File', formatBytes(hit.file.sizeBytes)].join(' · ');
  }
  return [
    hit.filesystem.filesystemKind === 'folder' ? 'Folder' : 'File',
    hit.filesystem.subtitle || hit.filesystem.name,
  ]
    .filter(Boolean)
    .join(' · ');
}

function hitKindLabel(hit: NodeMentionHit): string {
  if (hit.type === 'agent') return 'Agent';
  if (hit.type === 'entry') return 'Row';
  if (hit.type === 'trigger') return 'Trigger';
  if (hit.type === 'workspace') {
    return PREFIX_FILTER_META[hit.workspace.nodeType]?.label ?? hit.workspace.nodeType;
  }
  if (hit.type === 'file-node') return 'File';
  return hit.filesystem.filesystemKind === 'folder' ? 'Folder' : 'File';
}

function hitSectionLabel(hit: NodeMentionHit): string {
  if (hit.type === 'trigger') return 'Triggers';
  if (hit.type === 'filesystem') return 'Filesystem';
  const label = hitKindLabel(hit);
  if (label === 'Memory') return 'Memories';
  if (label === 'Summary') return 'Thread summaries';
  if (label === 'File') return 'Files';
  if (label === 'Folder') return 'Folders';
  return `${label}s`;
}

function filesystemHitToMentionHit(item: PaletteFilesystemItem): FilesystemMentionHit {
  return {
    type: 'filesystem',
    key: `fs:${item.filesystemKind}:${item.path}`,
    label: item.path,
    subtitle: [item.filesystemKind === 'folder' ? 'Folder' : 'File', item.subtitle || item.name]
      .filter(Boolean)
      .join(' · '),
    filesystem: item,
  };
}

function entryHitToMentionHit(entry: PaletteEntryHit): EntryMentionHit {
  return {
    type: 'entry',
    key: `entry:${entry.tableId}/${entry.entryId}`,
    label: entry.name || 'Untitled',
    subtitle: entry.tableName,
    entry,
  };
}

function fileNodeHitToMentionHit(item: PaletteFileNodeItem): FileNodeMentionHit {
  return {
    type: 'file-node',
    key: `file:${item.nodeId}`,
    label: item.relativePath,
    subtitle: ['File', formatBytes(item.sizeBytes)].join(' · '),
    file: item,
  };
}

function workspaceHitToMentionHit(item: PaletteWorkspaceItem): WorkspaceMentionHit {
  return {
    type: 'workspace',
    key: `ws:${item.nodeId}`,
    label: item.title,
    subtitle: item.subtitle,
    workspace: item,
  };
}

/** Flatten a palette response into mention hits (workspace → table rows → file-node → filesystem). */
function mentionHitsFromResponse(response: PaletteAugmentedResponse): NodeMentionHit[] {
  const workspaceHits = response.items
    .filter((item): item is PaletteWorkspaceItem => item.type === 'workspace')
    .map(workspaceHitToMentionHit);
  const filesystemHits = response.items
    .filter((item): item is PaletteFilesystemItem => item.type === 'filesystem')
    .map(filesystemHitToMentionHit);
  // Embedded file-node (semantic) matches travel in `response.files`.
  const fileNodeHits = response.files.map(fileNodeHitToMentionHit);
  const entryHits = (response.entries ?? []).map(entryHitToMentionHit);
  return [...workspaceHits, ...entryHits, ...fileNodeHits, ...filesystemHits];
}

// Stable empty default — an inline `= []` mints a new array identity every
// render, which poisons downstream memo/effect dependencies.
const NO_AGENT_OPTIONS: AgentMentionHit[] = [];
const NO_TRIGGER_OPTIONS: readonly MentionTriggerOption[] = [];

export const NodeMentionSearch = forwardRef<NodeMentionSearchHandle, Props>(
  function NodeMentionSearch(
    {
      open,
      anchorRect,
      query,
      threadId,
      agentOptions = NO_AGENT_OPTIONS,
      agentsUnavailable = false,
      triggerOptions = NO_TRIGGER_OPTIONS,
      workspaceOnly = false,
      onlyKinds,
      onSelect,
      onClose,
    },
    ref
  ) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    // Hover moves the selection only once the pointer really moves: rows that
    // appear under a resting pointer must not take Enter/Tab from the first row.
    const pointer = usePointerMoveGate();

    const triggerLaneEnabled = triggerOptions.length > 0;
    const parsed = useMemo(
      () => parseMentionQuery(query, triggerLaneEnabled),
      [query, triggerLaneEnabled]
    );
    const displayQuery = parsed.query.trim();
    const entryFilter = parsed.filters.includes('entry');
    const triggerLane = triggerLaneEnabled && parsed.filters.includes('trigger');
    const parsedSearchKinds = useMemo(
      () => searchKindsForFilters(parsed.filters),
      [parsed.filters]
    );
    const onlyServerKinds = useMemo<PaletteNodeKind[] | null>(
      () => (onlyKinds ? onlyKinds.filter((kind) => kind !== 'agent') : null),
      [onlyKinds]
    );
    const searchKinds = onlyServerKinds
      ? onlyServerKinds
      : workspaceOnly
        ? (workspaceKindsForFilters(parsed.filters) ?? [...PALETTE_NODE_KINDS])
        : parsedSearchKinds;
    // `node:` scopes the search to workspace nodes; the server re-parses it.
    const plan = planPaletteSearch({
      term: displayQuery,
      kinds: searchKinds,
      entryFilter: entryFilter ? { table: parsed.table ?? null } : null,
      // Table rows rank beside the nodes unless the search is scoped to a kind.
      allowEntries: !onlyKinds,
    });
    const queryText = onlyKinds
      ? displayQuery
      : plan.entryOnly
        ? parsed.table || displayQuery
          ? plan.query
          : ''
        : parsed.filters.includes('node')
          ? `node:${displayQuery}`
          : displayQuery;
    const searchEnabled =
      open &&
      !triggerLane &&
      (onlyServerKinds ? onlyServerKinds.length > 0 : true) &&
      (queryText.trim().length > 0 || (searchKinds?.length ?? 0) > 0);

    // Keyword hits render on every keystroke; semantic hits arrive debounced
    // and merge in below without reordering what's already on screen.
    const { instant, enriched, instantLoading, enrichmentLoading } = useTieredSearch({
      query: queryText,
      enabled: searchEnabled,
      kinds: entryFilter ? undefined : (searchKinds ?? undefined),
      includeEntries: plan.includeEntries,
      threadId,
      limit: 12,
      perKindLimit: 6,
    });
    const loading = instantLoading || enrichmentLoading;

    // Server hits = keyword (instant) hits, with semantic-only (enriched)
    // additions appended stably beneath them.
    const serverHits = useMemo<NodeMentionHit[]>(() => {
      const instantHits = instant ? mentionHitsFromResponse(instant) : [];
      const enrichedHits = enriched ? mentionHitsFromResponse(enriched) : [];
      const visible = (hit: NodeMentionHit) =>
        onlyServerKinds
          ? hit.type === 'workspace' && onlyServerKinds.includes(hit.workspace.nodeType)
          : !workspaceOnly || hit.type !== 'filesystem';
      const merged = stableMergeById(
        instantHits.filter(visible),
        enrichedHits.filter(visible),
        (hit) => hit.key
      );
      if (entryFilter) return merged;
      // Beside the nodes only the few closest rows; `entry:` lists them all (the shared limits).
      const cap = plan.rowLimit ?? Infinity;
      let rows = 0;
      return merged.filter((hit) => hit.type !== 'entry' || ++rows <= cap);
    }, [instant, enriched, workspaceOnly, onlyServerKinds, entryFilter, plan.rowLimit]);

    // Whether this search lists roster agents at all (a `doc:` or `file:`
    // filter, a picker for another kind, or the trigger lane does not).
    const agentLane = useMemo(() => {
      if (triggerLane) return false;
      if (onlyKinds) return onlyKinds.includes('agent');
      return !parsed.filters.some(
        (filter) =>
          filter === 'entry' ||
          filter === 'file' ||
          filter === 'folder' ||
          (filter !== 'agent' && PALETTE_NODE_KINDS.includes(filter as PaletteNodeKind))
      );
    }, [onlyKinds, parsed.filters, triggerLane]);

    const filteredAgents = useMemo(() => {
      if (!agentLane) return [];
      return agentOptions.filter((agent) => {
        if (!displayQuery) {
          return !!onlyKinds || parsed.filters.length === 0 || parsed.filters.includes('agent');
        }
        const haystack = [agent.agent.name, agent.agent.handle, agent.agent.role]
          .filter(Boolean)
          .join(' ');
        return matchesEveryWord(haystack, displayQuery);
      });
    }, [agentLane, agentOptions, displayQuery, onlyKinds, parsed.filters]);
    const agentsNote = agentLane && agentsUnavailable ? "Couldn't load agents" : null;

    const filteredTriggers = useMemo<TriggerMentionHit[]>(() => {
      if (!triggerLane) return [];
      return triggerOptions
        .filter((option) => matchesEveryWord(`${option.value} ${option.label}`, displayQuery))
        .map((option) => ({
          type: 'trigger',
          key: `trigger:${option.value}`,
          label: option.label,
          subtitle: option.value,
          trigger: option.value,
        }));
    }, [displayQuery, triggerLane, triggerOptions]);

    // A query that exactly matches an agent's name or handle (any case)
    // commits that agent on Enter/Tab, whatever hit is selected.
    const exactAgentHit = useMemo(() => {
      const needle = displayQuery.trim().toLowerCase();
      if (!needle) return null;
      return (
        filteredAgents.find((hit) => {
          const name = hit.agent.name?.trim().toLowerCase();
          const handle = hit.agent.handle?.trim().toLowerCase().replace(/^@/, '');
          return name === needle || handle === needle;
        }) ?? null
      );
    }, [filteredAgents, displayQuery]);

    // Back to the first row, and forget where the pointer rests, when the popup
    // opens or closes and on every query change. The tiered hook clears its own
    // results via `enabled`; result-shrink bounding is handled by the effect on
    // `results.length` below.
    useEffect(() => {
      setSelectedIndex(0);
      pointer.reset();
    }, [open, query, pointer]);

    // Final result list: local agent matches first, then server hits. The
    // palette search returns agents too, so a server agent hit for an agent
    // already listed locally is dropped by id (the local row carries the role).
    const results = useMemo<NodeMentionHit[]>(() => {
      if (triggerLane) return filteredTriggers;
      const localAgentIds = new Set(filteredAgents.map((hit) => hit.agent.id));
      const remoteHits = serverHits.filter(
        (hit) =>
          !(
            hit.type === 'workspace' &&
            hit.workspace.nodeType === 'agent' &&
            localAgentIds.has(hit.workspace.nodeId)
          )
      );
      return [...filteredAgents, ...remoteHits];
    }, [filteredAgents, filteredTriggers, serverHits, triggerLane]);
    const resultSections = useMemo<MentionResultSection[]>(() => {
      const sections = new Map<string, MentionResultSection>();
      results.forEach((hit, index) => {
        const key =
          hit.type === 'workspace'
            ? hit.workspace.nodeType
            : hit.type === 'filesystem'
              ? `filesystem:${hit.filesystem.filesystemKind}`
              : hit.type;
        const existing = sections.get(key);
        const section = existing ?? { key, label: hitSectionLabel(hit), items: [] };
        section.items.push({ hit, index });
        sections.set(key, section);
      });
      return Array.from(sections.values());
    }, [results]);

    // Keep the keyboard selection inside bounds as the list shrinks. Depends
    // on a primitive (length), so this cannot re-trigger itself.
    useEffect(() => {
      setSelectedIndex((current) => Math.min(current, Math.max(results.length - 1, 0)));
    }, [results.length]);

    useImperativeHandle(
      ref,
      () => ({
        moveSelection(delta: number) {
          setSelectedIndex((current) => {
            if (results.length === 0) return 0;
            return (current + delta + results.length) % results.length;
          });
        },
        confirmSelection() {
          const hit = results[selectedIndex];
          if (hit) onSelect(hit);
        },
        handleKeyDown(event: KeyboardEvent) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelectedIndex((current) => {
              if (results.length === 0) return 0;
              return (current + 1) % results.length;
            });
            return true;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelectedIndex((current) => {
              if (results.length === 0) return 0;
              return (current - 1 + results.length) % results.length;
            });
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            // A fully-typed agent name always wins, regardless of where
            // selectedIndex landed among the server hits.
            const hit = exactAgentHit ?? results[selectedIndex];
            if (!hit) return false;
            event.preventDefault();
            onSelect(hit);
            return true;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return true;
          }
          return false;
        },
      }),
      [exactAgentHit, onClose, onSelect, results, selectedIndex]
    );

    const handleSelect = useCallback(
      (hit: NodeMentionHit) => {
        onSelect(hit);
      },
      [onSelect]
    );

    if (!open) return null;

    return (
      <EditorPopover anchor={anchorRect} ariaLabel="Mention suggestions">
        <EditorPopoverHeader
          glyph="@"
          text={displayQuery ? `Search: ${displayQuery}` : 'Type to search…'}
          muted={!displayQuery}
        />

        {/*
         * The list renders whenever there are results, regardless of
         * `loading`, so local agent matches stay committable during a fetch.
         * Status rows show only with zero results; otherwise "Searching…" is
         * a footer.
         */}
        {results.length === 0 && loading ? (
          <div className={popoverStyles.status}>Searching…</div>
        ) : null}
        {results.length === 0 && !loading ? (
          <div className={popoverStyles.status} role={agentsNote ? 'status' : undefined}>
            {triggerLane
              ? 'No matching triggers'
              : (agentsNote ?? (displayQuery ? 'No matches' : 'Start typing a name'))}
          </div>
        ) : null}
        {results.length > 0 ? (
          <ul className={popoverStyles.list}>
            {resultSections.map((section) => (
              <li key={section.key}>
                <div className={popoverStyles.sectionHeader} role="presentation">
                  {section.label}
                </div>
                <ul className={popoverStyles.list}>
                  {section.items.map(({ hit, index }) => (
                    <li key={hit.key}>
                      <button
                        type="button"
                        className={clsx(
                          popoverStyles.row,
                          popoverStyles.rowKeyed,
                          index === selectedIndex && popoverStyles.rowActive
                        )}
                        role="option"
                        aria-selected={index === selectedIndex}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          handleSelect(hit);
                        }}
                        onMouseMove={(event) => {
                          if (pointer.moved(event)) setSelectedIndex(index);
                        }}
                      >
                        <span className={popoverStyles.body}>
                          <span className={popoverStyles.label}>{hitLabel(hit)}</span>
                          {hitSubtitle(hit) ? (
                            <span className={popoverStyles.meta}>{hitSubtitle(hit)}</span>
                          ) : null}
                        </span>
                        <span className={popoverStyles.kind}>{hitKindLabel(hit)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : null}
        {results.length > 0 && loading ? (
          <div className={popoverStyles.status}>Searching…</div>
        ) : null}
        {results.length > 0 && agentsNote ? (
          <div className={popoverStyles.status} role="status">
            {agentsNote}
          </div>
        ) : null}
        <button
          type="button"
          className={popoverStyles.srOnly}
          onClick={onClose}
          tabIndex={-1}
          aria-hidden="true"
        />
      </EditorPopover>
    );
  }
);
