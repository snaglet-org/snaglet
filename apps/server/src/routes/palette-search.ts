import { Router, type Request } from 'express';
import { PALETTE_NODE_KINDS, type PaletteNodeKind } from '@snaglet/shared/constants/nodeKinds';
import {
  PALETTE_ENTRY_FILTER_LIMIT,
  PALETTE_ENTRY_SECTION_LIMIT,
  PALETTE_SEARCH_MODES,
  type PaletteEntryHit,
  type PaletteSearchMode,
} from '@snaglet/shared/constants/paletteSearch';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';
import { paletteSearch } from '@server/services/search/paletteSearch';
import {
  searchProjectFilesystem,
  searchProjectFilesystemByProjectId,
  type PaletteFilesystemKind,
  type PaletteFilesystemResult,
} from '@server/services/search/filesystemSearch';
import {
  resolveNamedProjectScope,
  type NamedScopeResolution,
} from '@server/services/search/namedScope';
import {
  parseEntryQuery,
  resolveEntryTable,
  searchPaletteEntries,
  rowsOfTablesFirst,
  type PaletteEntryQuery,
} from '@server/services/search/paletteEntrySearch';
import type { ScopeResolutionError } from '@server/services/search/searchPolicy';
import {
  resolveFileNodeByPath,
  searchFileNodes,
  type FileNodePaletteHit,
} from '@server/services/search/fileNodeSearch';
import {
  shareMeaningBudget,
  type PaletteSearchInput,
  type PaletteSearchResult,
} from '@server/services/search/paletteSearchSupport';

type PaletteSearchResponse = PaletteSearchResult & {
  filesystem: PaletteFilesystemResult[];
  /** Embedded `file` node matches (semantic). Parallel to `filesystem` (filename fuzzy). */
  files: FileNodePaletteHit[];
  /**
   * Table rows: an `entry:` search's results, or the short Entries section an
   * unfiltered search asked for with `includeEntries`. Best first.
   */
  entries: PaletteEntryHit[];
};

type PaletteSearchRequest = Request & { threadId?: string };
type PaletteSearchKind = PaletteNodeKind | PaletteFilesystemKind;

const FILTER_PREFIX_RE = /^(agent|table|task|doc|thread|project|file|folder|node):/i;
const FILESYSTEM_FILTERS = new Set<PaletteFilesystemKind>(['file', 'folder']);
const PALETTE_NODE_KIND_SET = new Set<string>(PALETTE_NODE_KINDS);
// Palette kinds found in their own tables (agents, the table catalog) rather
// than public.nodes; a `node:` filter excludes them.
const NON_NODE_PALETTE_KINDS = new Set<PaletteNodeKind>(['agent', 'table']);
const FAST_INTERACTIVE_KINDS = PALETTE_NODE_KINDS.filter(
  (kind) => kind !== 'message' && kind !== 'thread_summary'
);
const CONVERSATION_EVIDENCE_INTENT_RE =
  /\b(?:when|where|what)\s+(?:did|do|have|was|were)\b[^?]*\b(?:discuss(?:ed)?|talk(?:ed)?|mention(?:ed)?|say|said|decid(?:e|ed)|agree(?:d)?)\b/i;
const STRUCTURED_SCOPE_KINDS = new Set<PaletteNodeKind>(['container', 'doc', 'thread', 'message']);

function normalizeQuery(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseQuery(rawQuery: string): { filter: string | null; searchTerm: string } {
  const trimmed = rawQuery.trimStart();
  const match = FILTER_PREFIX_RE.exec(trimmed);
  if (!match) return { filter: null, searchTerm: rawQuery.trim() };
  const filter = match[1].toLowerCase();
  return { filter, searchTerm: trimmed.slice(match[0].length).trim() };
}

function normalizeKinds(value: unknown): PaletteSearchKind[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<PaletteSearchKind>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const kind = item.toLowerCase();
    if (PALETTE_NODE_KIND_SET.has(kind) || FILESYSTEM_FILTERS.has(kind as PaletteFilesystemKind)) {
      seen.add(kind as PaletteSearchKind);
    }
  }
  return [...seen];
}

function normalizeThreadId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeScope(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function hasConversationEvidenceIntent(query: string): boolean {
  return CONVERSATION_EVIDENCE_INTENT_RE.test(query);
}

const PALETTE_SEARCH_MODE_SET = new Set<string>(PALETTE_SEARCH_MODES);
function normalizeMode(value: unknown): PaletteSearchMode | undefined {
  return typeof value === 'string' && PALETTE_SEARCH_MODE_SET.has(value)
    ? (value as PaletteSearchMode)
    : undefined;
}

/**
 * A search that asked for a scope it could not have. Carries no results on
 * purpose: widening to the whole workspace would answer a different question
 * and look identical to success.
 */
function scopeErrorResponse(
  query: string,
  scopeError: ScopeResolutionError,
  scopeSource: 'named_project' | 'named_table' = 'named_project'
): PaletteSearchResponse {
  return {
    byKind: {},
    channelsUsed: [],
    semanticStatus: 'disabled',
    coverage: {},
    executionPlan: {
      query,
      scopePolicy: 'strict',
      scopeSource,
      scopeError,
      ordering: 'relevance',
      gaps: [`scope not applied: ${scopeError.code}`],
    },
    filesystem: [],
    files: [],
    entries: [],
  };
}

/**
 * The refusal for a typed project scope that did not resolve, or that
 * disagrees with the scope the surface supplied; null when it can apply.
 */
function namedScopeError(
  named: NamedScopeResolution,
  searchTerm: string,
  bodyScopeId: string | undefined
): PaletteSearchResponse | null {
  if (named.status === 'not_found') {
    return scopeErrorResponse(searchTerm, {
      code: 'not_found',
      name: named.name,
      message: `No project named "${named.name}".`,
    });
  }
  if (named.status === 'ambiguous') {
    return scopeErrorResponse(searchTerm, {
      code: 'ambiguous',
      name: named.name,
      matches: named.matches.map((match) => match.projectName),
      message: `More than one project is named "${named.name}". Rename one, or search from inside the project you mean.`,
    });
  }
  // A surface-supplied scope and a typed scope phrase are two different
  // people asking for two different things. Narrowing to one of them would
  // be a precedence rule the caller cannot see, so a genuine disagreement is
  // reported rather than resolved. Naming the project you are already scoped
  // to is not a disagreement.
  if (named.status === 'resolved' && bodyScopeId && bodyScopeId !== named.projectId) {
    return scopeErrorResponse(searchTerm, {
      code: 'conflict',
      name: named.projectName,
      message: `This search is already scoped elsewhere, so it cannot also be limited to "${named.projectName}". Remove one of the two.`,
    });
  }
  return null;
}

/** Quick search's short Entries section needs at least this many characters. */
const ENTRY_SECTION_MIN_QUERY_LENGTH = 2;

/**
 * `entry: <keywords>` and `table:<name> entry: <keywords>`: table rows only.
 * A trailing project phrase (`… in "Project"`) or a surface project scope
 * keeps to that project's tables; a folder scope finds none, since tables
 * never live in folders. A table name that matches several tables, or none,
 * is reported instead of searching every table.
 */
async function entryFilterResponse(
  entryQuery: PaletteEntryQuery,
  projectId: string | undefined,
  containerId: string | undefined
): Promise<PaletteSearchResponse> {
  const named = await resolveNamedProjectScope(entryQuery.keywords);
  const refused = namedScopeError(named, entryQuery.keywords, projectId ?? containerId);
  if (refused) return refused;
  const keywords = named.status === 'resolved' ? named.residualQuery : entryQuery.keywords;
  const scopeProjectId = named.status === 'resolved' ? named.projectId : projectId;
  let table: { id: string; name: string } | undefined;
  if (entryQuery.tableName) {
    const resolution = await resolveEntryTable(entryQuery.tableName);
    if (resolution.status === 'ambiguous') {
      return scopeErrorResponse(
        keywords,
        {
          code: 'ambiguous',
          name: resolution.name,
          matches: resolution.matches,
          message: resolution.message,
        },
        'named_table'
      );
    }
    if (resolution.status !== 'resolved') {
      return scopeErrorResponse(
        keywords,
        { code: 'not_found', name: resolution.name, message: resolution.message },
        'named_table'
      );
    }
    if (scopeProjectId && resolution.projectId !== scopeProjectId) {
      return scopeErrorResponse(
        keywords,
        {
          code: 'conflict',
          name: resolution.tableName,
          message: `${resolution.tableName} is not in ${named.status === 'resolved' ? `"${named.projectName}"` : 'this project'}. Remove one of the two.`,
        },
        'named_table'
      );
    }
    table = { id: resolution.tableId, name: resolution.tableName };
  }
  const folderScoped = !scopeProjectId && Boolean(containerId);
  const entries = folderScoped
    ? []
    : await searchPaletteEntries({
        keywords,
        ...(table ? { tableId: table.id } : scopeProjectId ? { projectId: scopeProjectId } : {}),
        limit: PALETTE_ENTRY_FILTER_LIMIT,
        byMeaning: true,
      });
  return {
    byKind: {},
    channelsUsed: entries.length > 0 ? ['fts'] : [],
    semanticStatus: 'disabled',
    coverage: {},
    executionPlan: {
      query: keywords,
      scopePolicy: table || scopeProjectId || containerId ? 'strict' : 'neutral',
      scopeSource: table
        ? 'named_table'
        : named.status === 'resolved'
          ? 'named_project'
          : undefined,
      scopeLabel: table?.name ?? (named.status === 'resolved' ? named.projectName : undefined),
      scopeId: table?.id ?? scopeProjectId ?? containerId,
      ordering: 'relevance',
      gaps: folderScoped ? ['entries not searched: tables do not live in folders'] : [],
    },
    filesystem: [],
    files: [],
    entries,
  };
}

const paletteSearchRouter = Router();

paletteSearchRouter.post(
  '/',
  asyncHandler(async (req: PaletteSearchRequest, res) => {
    const rawQuery = normalizeQuery(req.body?.query);
    const mode = normalizeMode(req.body?.mode);
    const projectId = normalizeScope(req.body?.projectId);
    const containerId = normalizeScope(req.body?.containerId);
    const entryQuery = parseEntryQuery(rawQuery);
    if (entryQuery) {
      sendOk(res, await entryFilterResponse(entryQuery, projectId, containerId));
      return;
    }
    const { filter, searchTerm } = parseQuery(rawQuery);
    const requestKinds = normalizeKinds(req.body?.kinds);

    // Named scope is read from the query text after the `kind:` prefix is
    // stripped — the prefix leads, the scope phrase trails, and both may
    // appear on the same query.
    const named = await resolveNamedProjectScope(searchTerm);
    const refused = namedScopeError(named, searchTerm, projectId ?? containerId);
    if (refused) {
      sendOk(res, refused);
      return;
    }

    // The phrase comes off the query only now that it resolved. An unresolved
    // phrase stays part of the search text, because it was probably prose.
    const effectiveSearchTerm = named.status === 'resolved' ? named.residualQuery : searchTerm;
    const namedProjectId = named.status === 'resolved' ? named.projectId : undefined;
    const explicitScope = namedProjectId
      ? { project_id: namedProjectId }
      : projectId
        ? { project_id: projectId }
        : containerId
          ? { container_id: containerId }
          : undefined;
    const requestWorkspaceKinds = requestKinds.filter((kind): kind is PaletteNodeKind =>
      PALETTE_NODE_KIND_SET.has(kind)
    );
    const requestFilesystemKinds = requestKinds.filter((kind): kind is PaletteFilesystemKind =>
      FILESYSTEM_FILTERS.has(kind as PaletteFilesystemKind)
    );
    const prefixFilesystemKind = FILESYSTEM_FILTERS.has(filter as PaletteFilesystemKind)
      ? (filter as PaletteFilesystemKind)
      : null;
    const prefixWorkspaceKinds =
      filter && !prefixFilesystemKind && filter !== 'node'
        ? [filter === 'project' ? 'container' : filter === 'task' ? 'doc' : filter].filter(
            (kind): kind is PaletteNodeKind => PALETTE_NODE_KIND_SET.has(kind)
          )
        : [];
    const workspaceOnly = filter === 'node';
    const filesystemOnly =
      (prefixFilesystemKind !== null || requestFilesystemKinds.length > 0) &&
      !workspaceOnly &&
      requestWorkspaceKinds.length === 0 &&
      prefixWorkspaceKinds.length === 0;
    const nodeKinds = workspaceOnly
      ? PALETTE_NODE_KINDS.filter((kind) => !NON_NODE_PALETTE_KINDS.has(kind))
      : requestWorkspaceKinds.length > 0
        ? requestWorkspaceKinds
        : prefixWorkspaceKinds.length > 0
          ? prefixWorkspaceKinds
          : filesystemOnly
            ? []
            : undefined;
    const defaultInteractiveKinds =
      effectiveSearchTerm && requestKinds.length === 0 && filter === null
        ? mode !== 'keyword' || hasConversationEvidenceIntent(effectiveSearchTerm)
          ? [...PALETTE_NODE_KINDS]
          : FAST_INTERACTIVE_KINDS
        : undefined;
    const filesystemKinds =
      requestFilesystemKinds.length > 0
        ? requestFilesystemKinds
        : prefixFilesystemKind
          ? [prefixFilesystemKind]
          : [];
    const hasWorkspaceFilter =
      workspaceOnly || requestWorkspaceKinds.length > 0 || prefixWorkspaceKinds.length > 0;
    const hasFilesystemFilter = filesystemKinds.length > 0 || prefixFilesystemKind !== null;
    const shouldSearchFilesystem =
      mode !== 'semantic' &&
      !workspaceOnly &&
      (hasFilesystemFilter ||
        (requestKinds.length === 0 && prefixWorkspaceKinds.length === 0 && filter === null));
    const filesystemFilter =
      filesystemKinds.length === 1 ? filesystemKinds[0] : (prefixFilesystemKind ?? null);
    const hasStructuredExecution = Boolean(explicitScope);
    const plannedKinds = nodeKinds ?? defaultInteractiveKinds;
    const structuredKinds = explicitScope
      ? plannedKinds?.filter((kind) => STRUCTURED_SCOPE_KINDS.has(kind))
      : plannedKinds;

    const searchInput: PaletteSearchInput = {
      query: effectiveSearchTerm,
      kinds: structuredKinds,
      perKindLimit: req.body?.perKindLimit,
      clientDebounceMs: req.body?.clientDebounceMs,
      mode,
      scope: explicitScope,
      broadInteractiveSearch:
        requestKinds.length === 0 && prefixWorkspaceKinds.length === 0 && filter === null,
      timeRange: null,
      orderBy: 'relevance',
    };

    // File nodes (embedded content) show with no filter or under `file:`.
    // Excluded under folder:/agent:/node:/<other-kind>: so those filters stay
    // crisp. Runs concurrently with the node + filesystem searches.
    // Skipped entirely on the keyword tier: file nodes are vector-only (they
    // embed the query), which is exactly the cost the instant tier avoids —
    // they arrive with the debounced hybrid enrichment instead.
    const includeFileNodes =
      mode !== 'keyword' &&
      !hasWorkspaceFilter &&
      ((requestKinds.length === 0 && filter === null) ||
        filesystemKinds.includes('file') ||
        prefixFilesystemKind === 'file');
    // The short Entries section: asked for by the palette (other search
    // surfaces cannot show rows), unfiltered searches only, keyword-backed,
    // and kept to the scope's project. Tables never live in folders.
    // A `table:` filter alone keeps the Entries section: its results are the tables, then their rows
    // (never docs, memories and the rest).
    const tableOnlyFilter =
      !workspaceOnly &&
      !filesystemOnly &&
      requestFilesystemKinds.length === 0 &&
      nodeKinds?.length === 1 &&
      nodeKinds[0] === 'table';
    const includeEntries =
      req.body?.includeEntries === true &&
      (searchInput.broadInteractiveSearch === true || tableOnlyFilter) &&
      mode !== 'semantic' &&
      effectiveSearchTerm.length >= ENTRY_SECTION_MIN_QUERY_LENGTH &&
      !(explicitScope?.container_id && !explicitScope.project_id);
    const [baseResults, filesystem, files, entries] = await Promise.all([
      paletteSearch(searchInput),
      // A named project keeps both file lanes running — scoped, not skipped.
      // Dropping them would answer "find X in project Y" without ever looking
      // at project Y's files. The folder root comes from the named project
      // rather than the caller's thread, which is the whole point of naming it.
      shouldSearchFilesystem && (namedProjectId || !hasStructuredExecution)
        ? namedProjectId
          ? searchProjectFilesystemByProjectId(
              namedProjectId,
              effectiveSearchTerm,
              filesystemFilter
            )
          : searchProjectFilesystem(
              normalizeThreadId(req.body?.threadId) ?? req.threadId,
              effectiveSearchTerm,
              filesystemFilter
            )
        : Promise.resolve([] as PaletteFilesystemResult[]),
      includeFileNodes && (namedProjectId || !hasStructuredExecution)
        ? searchFileNodes(
            effectiveSearchTerm,
            Number(req.body?.limit) > 0 ? Number(req.body.limit) : 8,
            explicitScope?.project_id ? { projectId: explicitScope.project_id } : undefined
          )
        : Promise.resolve([] as FileNodePaletteHit[]),
      includeEntries
        ? searchPaletteEntries({
            keywords: effectiveSearchTerm,
            ...(explicitScope?.project_id ? { projectId: explicitScope.project_id } : {}),
            limit: PALETTE_ENTRY_SECTION_LIMIT,
          })
        : Promise.resolve([] as PaletteEntryHit[]),
    ]);

    // paletteSearch returns kind-bucketed hits (byKind), not a flat node
    // list — apply the prefix-filter semantics per bucket.
    const kindShown = (kind: string): boolean => {
      if (requestWorkspaceKinds.length > 0) {
        return requestWorkspaceKinds.includes(kind as PaletteNodeKind);
      }
      return !filesystemOnly;
    };
    const filteredByKind = Object.fromEntries(
      Object.entries(baseResults.byKind).map(([kind, hits]) => [kind, kindShown(kind) ? hits : []])
    ) as PaletteSearchResult['byKind'];
    // Files are found by meaning only, so in a broad search they share the
    // meaning budget with the workspace's meaning-only hits.
    const shown = searchInput.broadInteractiveSearch
      ? shareMeaningBudget(filteredByKind, files)
      : { byKind: filteredByKind, files };
    const response: PaletteSearchResponse = {
      ...baseResults,
      byKind: shown.byKind,
      executionPlan: {
        query: effectiveSearchTerm,
        scopePolicy: explicitScope ? 'strict' : 'neutral',
        scopeSource: namedProjectId ? 'named_project' : explicitScope ? 'explicit' : undefined,
        // Only a named project has a name to report. An id-scoped request
        // already knows what it asked for; inventing a label for it would mean
        // a second lookup to say something the caller told us.
        scopeLabel: named.status === 'resolved' ? named.projectName : undefined,
        scopeId: explicitScope?.project_id ?? explicitScope?.container_id,
        ordering: 'relevance',
        gaps: [],
      },
      filesystem: shouldSearchFilesystem ? filesystem : [],
      files: shown.files,
      // Under a `table:` filter: the tables, then the rows of the best matching ones, then other matching rows.
      entries: tableOnlyFilter
        ? await rowsOfTablesFirst(
            (filteredByKind.table ?? []).map((hit) => hit.node_id),
            entries,
            PALETTE_ENTRY_SECTION_LIMIT
          )
        : entries,
    };

    sendOk(res, response);
    return;
  })
);

paletteSearchRouter.post(
  '/resolve-file-path',
  asyncHandler(async (req, res) => {
    const path = normalizeQuery(req.body?.path);
    const file = path ? await resolveFileNodeByPath(path) : null;
    sendOk(res, { file });
    return;
  })
);

export default paletteSearchRouter;
