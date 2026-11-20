// Chip markdown encoder: the only place the frontend emits chip markdown into
// saved or submitted text, so the server's content-ref parser always sees a
// form it can expand into the `links` graph. Link form is `[Title](href)`;
// include form is `![](href)` (docs only, no title: the live title is
// resolved at render time).

import type { NodeChipData } from './payload';
import { escapeRegex, LINK_LABEL_SOURCE } from '@snaglet/shared/utils';
import { KIND_TO_SCHEME, isIncludableKind } from './kinds';
import { nodeTitle } from './title';
import { filePathToChipHref, folderPathToChipHref } from './filePath';

/** Escape brackets / backslash so a chip's title can't break out of the
 *  `[...]` portion of the markdown syntax. `[` needs escaping too: a title
 *  like `[DRAFT] Memo` would otherwise open a nested bracket pair and the
 *  link fails to parse at all (stray leading text + broken chip). */
export const escapeChipTitle = (title: string): string =>
  title.replace(/[\r\n]+/g, ' ').replace(/[[\]\\]/g, '\\$&');

/** Inverse of {@link escapeChipTitle} for a parsed `[...]` chip label. */
export const unescapeChipTitle = (title: string): string => title.replace(/\\([[\]\\])/g, '$1');

/**
 * Build the href for a chip pointing to this node. Uses the prefixed id
 * (`doc-…`, `thread-…`, …) when the id already carries its kind, else the
 * `<scheme>:<uuid>` form for bare UUIDs. `thread_summary` is listed before
 * `thread` in the alternation so a `thread_summary-…` id doesn't
 * short-match as `thread-…`.
 */
export const chipHrefForNode = (node: NodeChipData): string => {
  // File / folder chips reference an absolute path, not a node id, so they get
  // a dedicated `file:`/`folder:` href — that's what makes them parse out as the
  // path, not an id (see parseNodeRef).
  if (node.kind === 'file') return filePathToChipHref(node.id);
  if (node.kind === 'folder') return folderPathToChipHref(node.id);
  // Model ids are provider-authored identifiers (often containing `/` or
  // `:`), not workspace-node ids. Keep the entire value behind a dedicated
  // frontend-only scheme; the server link graph deliberately ignores it.
  if (node.kind === 'model') return `model:${node.id}`;
  // Table catalog ids (`table-…`) are not node ids. The dedicated scheme keeps
  // them out of every node-id grammar, so bare `table-…` prose never chips.
  if (node.kind === 'table') return `table:${node.id}`;
  if (node.kind === 'entry') return `entry:${node.id}`;
  // Agent ids are bare name-slugs (`clio`), so the href is the id, matching
  // the @-mention insert path; parseNodeRef resolves it via the agents
  // cache. The `agent:` scheme form would not parse (its grammar requires
  // a UUID/timestamp body).
  if (node.kind === 'agent') return node.id;
  // Listing message here keeps the `message-<id>` form intact instead of
  // falling through to `message:<…>`.
  if (
    /^(?:doc|thread_summary|thread|container|project|task|post|memory|tool|message|image|sketch)-/.test(
      node.id
    )
  ) {
    return node.id;
  }
  return `${KIND_TO_SCHEME[node.kind]}:${node.id}`;
};

interface ChipMarkdownOptions {
  /** Emit the include form `![](href)`. Ignored for non-includable
   *  kinds (everything except `doc`) — they always render as link
   *  chips even when this is true. */
  include?: boolean;
}

/** Emit the canonical chip markdown for a node. */
export const nodeToChipMarkdown = (
  node: NodeChipData,
  { include = false }: ChipMarkdownOptions = {}
): string => {
  const href = chipHrefForNode(node);
  if (include && isIncludableKind(node.kind)) {
    return `![](${href})`;
  }
  const title = node.kind === 'entry' ? (node.title ?? node.name ?? '') : nodeTitle(node);
  return `[${escapeChipTitle(title)}](${href})`;
};

/**
 * Toggle every chip in `content` matching `href` between link and include
 * form (`[Title](href)` ↔ `![](href)`). `liveTitleForLink` supplies the
 * title when converting an include back to a link, since the include form
 * has none; falls back to a title kept in `![Some Title](href)` source, then
 * to "doc". Returns `content` unchanged when no chip matches.
 */
export const toggleChipIncludeInMarkdown = (
  content: string,
  href: string,
  liveTitleForLink: string | null = null
): string => {
  // Labels follow the server's grammar: escaped and nested brackets.
  const re = new RegExp(`(!?)\\[(${LINK_LABEL_SOURCE})\\]\\(${escapeRegex(href)}\\)`, 'g');
  return content.replace(re, (_match, bang: string, currentTitle: string) => {
    if (bang === '!') {
      const newTitle =
        (liveTitleForLink && escapeChipTitle(liveTitleForLink)) || currentTitle || 'doc';
      return `[${newTitle}](${href})`;
    }
    return `![](${href})`;
  });
};
