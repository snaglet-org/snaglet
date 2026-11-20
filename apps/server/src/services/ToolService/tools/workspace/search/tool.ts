import type { ToolHandler } from '@server/services/ToolService/types';
import workspaceSearch from '@server/services/ToolService/handlers/search/workspaceSearch/workspaceSearch';
import docSearch from '@server/services/ToolService/handlers/search/docSearch';
import containerSearch from '@server/services/ToolService/handlers/search/containerSearch';
import codeSearch from '@server/services/ToolService/handlers/search/codeSearch';
import semanticFileSearch from '@server/services/ToolService/handlers/search/semanticFileSearch';
import entrySearch from '@server/services/ToolService/handlers/search/entrySearch';
import databaseSearch from '@server/services/ToolService/handlers/search/databaseSearch';
import findConversation from '@server/services/ToolService/handlers/search/findConversation/findConversation';
import listArchived from '@server/services/ToolService/handlers/search/listArchived';
import listRecent from '@server/services/ToolService/handlers/search/listRecent';

/**
 * `content_range` is a workspace-knowledge feature: it re-reads a node's
 * authoritative content (doc/message/memory/file). The focused backends below
 * return rows, filenames, or thread summaries with no such source, so a range
 * there is a caller mistake — say so rather than ignoring the parameter.
 */
const RANGED_BACKENDS = new Set([undefined, null, '', 'all', 'workspace']);

const tool: ToolHandler = async (input, settings, context) => {
  // Entries are table rows: a focused backend like the others, so `kinds` names it alone.
  const kindsList = Array.isArray(input.kinds) ? input.kinds : [];
  const wantsEntries = kindsList.includes('entry');
  if (wantsEntries && kindsList.length > 1) {
    return 'kinds: ["entry"] searches table rows on its own; do not combine it with other kinds. Run a second search for those.';
  }

  if (input.content_range != null) {
    if (wantsEntries) {
      return 'content_range is supported only on the workspace backend (kind: "all" or "workspace"), not kinds: ["entry"]. Read a row with table(op:read, table, ids).';
    }
    const kind = typeof input.kind === 'string' ? input.kind.trim() : input.kind;
    if (!RANGED_BACKENDS.has(kind as string | undefined | null)) {
      return `content_range is supported only on the workspace backend (kind: "all" or "workspace"), not kind: "${String(kind)}".`;
    }
    if (input.archived_only === true || input.sort === 'recent') {
      return 'content_range is not supported with archived_only or sort:"recent" — those are listing routes with no content to range. Fetch an id with content_range instead.';
    }
  }

  if (wantsEntries) return entrySearch(input, settings, context);

  if (input.archived_only === true) {
    const kinds = Array.isArray(input.kinds) ? input.kinds : [];
    const result = await listArchived({
      limit: typeof input.limit === 'number' ? input.limit : undefined,
      type: typeof kinds[0] === 'string' ? kinds[0] : undefined,
    });
    return JSON.stringify(result, null, 2);
  }
  if (input.sort === 'recent') return listRecent(input, settings, context);

  switch (input.kind) {
    case 'docs':
      return docSearch(input, settings, context);
    case 'containers':
      return containerSearch(input, settings, context);
    case 'code':
      return codeSearch(
        { ...input, mode: input.code_mode, max_results: input.limit },
        settings,
        context
      );
    case 'files':
      return semanticFileSearch({ ...input, maxResults: input.limit }, settings, context);
    case 'database':
      return databaseSearch(input, settings, context);
    case 'conversations':
      return findConversation(input, settings, context);
    default:
      return workspaceSearch(input, settings, context);
  }
};

export default tool;
