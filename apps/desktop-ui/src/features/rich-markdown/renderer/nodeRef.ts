/**
 * Parse a node-reference URL into `{ kind, id }`. Recognizes the scheme form
 * (`page:uuid`, `thread:uuid`; schemes from the server's LinkNodeType) and the
 * prefixed-id form (`doc-…`, `container-…`; matches `public.node_type`).
 * Returns `null` for other URLs so callers can render a plain `<a>`.
 */

import {
  HEADING_FRAGMENT_SOURCE,
  LINE_FRAGMENT_SOURCE,
  TOOL_ID_SOURCE,
  isToolId,
  parseLineFragment,
  splitDocRef,
  withLineRef,
  type DocAnchor,
} from '@snaglet/shared/utils';
import { TABLE_CATALOG_ID_PATTERN, isTableCatalogId } from '@snaglet/shared/types/tables';
import { getAgentsCached } from '../editor/agentMentionCache';
import { getCachedTableByName } from '@desktop/features/database/tableNameCache';
import { ENTRY_HREF_SOURCE, parseEntryChipId } from '@desktop/utils/nodeChip/entry';
import {
  filePathToChipHref,
  parseFilePathChipHref,
  parseFolderPathChipHref,
} from '@desktop/utils/nodeChip/filePath';

// Re-exported from utils/nodeChip for importers of this module.
export { filePathToChipHref, parseFilePathChipHref, parseFolderPathChipHref };

/** Kinds that can appear as a transclusion (`![](href)`). */
export const INCLUDABLE_KINDS = new Set(['page', 'doc']);

// Kind vocabularies as alternation strings, so NODE_HREF_SOURCE below can
// compose them into larger patterns.
// `run` is a scheme only, not in PREFIXED_KINDS: run ids are bare UUIDs, so
// `run:<uuid>` is the only form a run chip takes, and bare `run-…` text must
// not become a chip. Runs aren't `public.nodes` rows, so they form no
// `links` edge.
const LEGACY_KINDS_ALT =
  'page|container|library_node|thread_summary|thread|message|memory|agent|task|project|tool|doc|image|sketch|post|run';

// Longest prefixes first so `thread_summary` isn't matched as `thread`.
// Exported for the bare-id remark plugin.
export const PREFIXED_KINDS = Object.freeze([
  'thread_summary',
  'container',
  'message',
  'project',
  'memory',
  'thread',
  'agent',
  'image',
  // Retired kinds: `sketch-…` / `post-…` ids in stored content render as an
  // unavailable pill rather than raw text or a dead link.
  'sketch',
  'post',
  'task',
  'tool',
  'doc',
] as const);
const PREFIXED_KINDS_ALT = PREFIXED_KINDS.join('|');

const LEGACY_SCHEME_RE = new RegExp(`^(${LEGACY_KINDS_ALT}):`, 'i');
const PREFIXED_KIND_RE = new RegExp(`^(${PREFIXED_KINDS_ALT})-`, 'i');

// The two id body shapes: `generateId` (timestamp millis + base36) and UUID
// v4. Anything else after the prefix (`task-foo`, a half-typed id) stays
// plain text.
const TIMESTAMP_ID_BODY_SOURCE = '\\d{10,}-[A-Za-z0-9]+';
const UUID_BODY_SOURCE =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** Regex source for the part of an id after the kind prefix or scheme. */
export const NODE_ID_BODY_SOURCE = `(?:${TIMESTAMP_ID_BODY_SOURCE}|${UUID_BODY_SOURCE})`;
const NODE_ID_BODY_RE = new RegExp(`^${NODE_ID_BODY_SOURCE}$`);

const MODEL_HREF_SOURCE = 'model:[^)\\s]+';
// Table chips are `table:<catalog id>`. A catalog id is not a node id, so
// `table` is deliberately absent from both kind vocabularies above: only the
// explicit scheme parses, and bare `table-…` prose never becomes a chip.
const TABLE_CATALOG_ID_SOURCE = TABLE_CATALOG_ID_PATTERN.source.replace(/^\^|\$$/g, '');
const TABLE_HREF_PREFIX = 'table:';
const TABLE_HREF_SOURCE = `${TABLE_HREF_PREFIX}${TABLE_CATALOG_ID_SOURCE}`;
/** Regex source (no anchors or flags) for a node-shaped href, scheme:body or
 *  kind-body, for embedding in larger patterns. Only valid id bodies match,
 *  so `task-foo` never becomes a chip. */
export const NODE_HREF_SOURCE = `(?:${ENTRY_HREF_SOURCE}|${MODEL_HREF_SOURCE}|${TABLE_HREF_SOURCE}|(?:(?:${LEGACY_KINDS_ALT}):|(?:${PREFIXED_KINDS_ALT})-)${NODE_ID_BODY_SOURCE}(?:#(?:${LINE_FRAGMENT_SOURCE}|${HEADING_FRAGMENT_SOURCE}))?)`;

// Tool ids are name slugs (`weather`, `weather_today`), so a `tool:` href takes
// the tool id grammar; parseNodeRef applies it to every `[Title](tool:<id>)`.
const TOOL_HREF_PREFIX = 'tool:';
/**
 * Regex source for a `tool:<slug id>` href standing on its own. It is kept out
 * of {@link NODE_HREF_SOURCE}: prose bare-id parsing would chip ordinary text
 * such as `tool:create` or `[tool:policy]`. Only id-only (`passIdOnly`) inputs,
 * which store a tool chip as its href, and link-shaped contexts use it. The
 * boundaries keep it from matching inside a longer token (`stool:x`,
 * `socket:tool:x`, `[tool:x]`) or cutting a fragment off (`tool:<id>#L2`).
 */
export const TOOL_HREF_SOURCE = `(?<![A-Za-z0-9_:/\\[\\-])${TOOL_HREF_PREFIX}${TOOL_ID_SOURCE}(?![A-Za-z0-9_/#\\]\\-])`;

// A Database row linked by its table's name: `[Title](<table name>:<entry
// uuid>)`, the form agents write after reading a table by its SQL name. The
// canonical entry chip is `entry:<table id>/<uuid>`; this form resolves through
// the loaded table catalog, so it chips only once the catalog names a custom
// table. A kind scheme (`page:<uuid>`, `thread:<uuid>`, …) is matched first and
// wins over a table that shares its name.
// Both letter cases are spelled out, so the sources compose without the `i` flag.
const TABLE_NAME_SOURCE = '[A-Za-z][A-Za-z0-9_]{0,62}';
/** Bare regex *source* for a row-by-table-name href (`<table name>:<uuid>`). */
export const TABLE_ROW_BY_NAME_SOURCE = `${TABLE_NAME_SOURCE}:${UUID_BODY_SOURCE}`;
const TABLE_ROW_BY_NAME_RE = new RegExp(`^(${TABLE_NAME_SOURCE}):(${UUID_BODY_SOURCE})$`);
const TABLE_ROW_BY_NAME_LINK_RE = new RegExp(`\\]\\((${TABLE_ROW_BY_NAME_SOURCE})\\)`, 'g');

function tableRowByName(href: string): NodeRef | null {
  const match = TABLE_ROW_BY_NAME_RE.exec(href);
  const table = match ? getCachedTableByName(match[1]) : null;
  const entry = table && match ? parseEntryChipId(`${table.id}/${match[2]}`) : null;
  return entry ? { kind: 'entry', id: `${entry.tableId}/${entry.entryId}` } : null;
}

/**
 * Whether `href` links a row by its table's name (and not a kind scheme such
 * as `thread:<uuid>`), so it resolves once the table catalog knows the name.
 */
export function isTableRowHrefByName(href: string): boolean {
  return TABLE_ROW_BY_NAME_RE.test(href) && !LEGACY_SCHEME_RE.test(href);
}

/**
 * Whether `markdown` links a row by its table's name, so a surface can load
 * the table catalog and re-parse once it knows which names are tables.
 */
export function hasTableRowLinkByName(markdown: string): boolean {
  for (const match of markdown.matchAll(TABLE_ROW_BY_NAME_LINK_RE)) {
    if (isTableRowHrefByName(match[1] ?? '')) return true;
  }
  return false;
}

/**
 * Regex source for a standalone bare table catalog id. Only id-only
 * (`passIdOnly`) inputs use it: they store a table chip as its bare catalog id
 * and must re-render that value as a chip. Prose surfaces never do.
 */
export const BARE_TABLE_ID_SOURCE = `(?<![A-Za-z0-9_:/\\-])${TABLE_CATALOG_ID_SOURCE}(?![A-Za-z0-9_/\\-])`;

/** Chip href for a bare value an id-only input stored, when it is a table catalog id. */
export function tableChipHrefForBareId(value: string): string | null {
  return isTableCatalogId(value) ? `${TABLE_HREF_PREFIX}${value}` : null;
}

/**
 * The value an id-only (`passIdOnly`) input persists for a chip: the href,
 * except a table chip stores its bare catalog id (what id-keyed consumers
 * such as the related-table field compare against).
 */
export function idOnlyChipValue(href: string): string {
  const id = href.startsWith(TABLE_HREF_PREFIX) ? href.slice(TABLE_HREF_PREFIX.length) : null;
  return id && isTableCatalogId(id) ? id : href;
}

export interface NodeRef {
  /** Lowercased kind (e.g. 'doc', 'thread'). */
  kind: string;
  /** Bare id with the kind prefix / scheme stripped. */
  id: string;
  /** Partial-doc link: lines (`doc-…#L12-L20`) or a heading's section
   *  (`doc-…#h=rate-limits`). */
  anchor?: DocAnchor;
}

/**
 * A `task:` / `task-…` chip names a doc with the same id, so the `task` kind
 * parses as `doc`.
 */
const normalizeChipKind = (kind: string): string => (kind === 'task' ? 'doc' : kind);

export function parseNodeRef(href: string): NodeRef | null {
  if (!href) return null;
  // Doc line link: `doc-…#L12-L20`. Only docs carry lines; the fragment never
  // changes which node the chip is.
  if (href.includes('#')) {
    const { id, anchor } = splitDocRef(href);
    if (!anchor) return null;
    const ref = parseNodeRef(id);
    return ref && ref.kind === 'doc' ? { ...ref, anchor } : null;
  }
  if (href.startsWith('entry:')) {
    const entry = parseEntryChipId(href.slice('entry:'.length));
    return entry ? { kind: 'entry', id: `${entry.tableId}/${entry.entryId}` } : null;
  }
  if (href.startsWith('model:')) {
    const id = href.slice('model:'.length);
    return id && !/[)\s]/.test(id) ? { kind: 'model', id } : null;
  }
  if (href.startsWith(TABLE_HREF_PREFIX)) {
    const id = href.slice(TABLE_HREF_PREFIX.length);
    return isTableCatalogId(id) ? { kind: 'table', id } : null;
  }
  if (href.startsWith(TOOL_HREF_PREFIX)) {
    const id = href.slice(TOOL_HREF_PREFIX.length);
    return isToolId(id) ? { kind: 'tool', id } : null;
  }
  const filePath = parseFilePathChipHref(href);
  if (filePath) return { kind: 'file', id: filePath };
  const folderPath = parseFolderPathChipHref(href);
  if (folderPath) return { kind: 'folder', id: folderPath };
  const legacy = LEGACY_SCHEME_RE.exec(href);
  if (legacy) {
    const id = href.slice(legacy[0].length);
    // The body is a bare UUID or timestamp id, or a prefixed id of the same
    // kind (`doc:doc-1782…-abc`, as agents write `[Title](kind:id)`). In the
    // prefixed case `id` keeps the prefix, like the prefixed-id branch below.
    if (NODE_ID_BODY_RE.test(id)) {
      return { kind: normalizeChipKind(legacy[1].toLowerCase()), id };
    }
    const nestedPrefixed = PREFIXED_KIND_RE.exec(id);
    if (nestedPrefixed) {
      const nestedBody = id.slice(nestedPrefixed[0].length);
      if (
        NODE_ID_BODY_RE.test(nestedBody) &&
        nestedPrefixed[1].toLowerCase() === legacy[1].toLowerCase()
      ) {
        return { kind: normalizeChipKind(legacy[1].toLowerCase()), id };
      }
    }
    return null;
  }
  const prefixed = PREFIXED_KIND_RE.exec(href);
  if (prefixed) {
    const body = href.slice(prefixed[0].length);
    if (!NODE_ID_BODY_RE.test(body)) return null;
    return { kind: normalizeChipKind(prefixed[1].toLowerCase()), id: href };
  }
  const tableRow = tableRowByName(href);
  if (tableRow) return tableRow;
  // Agent ids are bare name slugs (e.g. `my-agent`) with no kind prefix. An
  // href matching a known agent id is an agent chip; before the roster loads
  // it is not a node ref.
  const agents = getAgentsCached();
  if (agents && agents.some((agent) => agent.id === href)) {
    return { kind: 'agent', id: href };
  }
  return null;
}

/**
 * `href` with a line link's range in its canonical form (`doc-…#L3-L5`).
 * Ranges written the way the chip label reads (`#L3–5`, `#L3-5`, or a dash a
 * markdown parser percent-encoded) parse too, but chips save the canonical
 * form, which the server's link index reads. Other hrefs come back as they are.
 */
export function canonicalNodeHref(href: string): string {
  const hash = href.indexOf('#');
  if (hash < 0) return href;
  const anchor = parseNodeRef(href)?.anchor;
  return anchor && 'lines' in anchor ? withLineRef(href.slice(0, hash), anchor.lines) : href;
}

/**
 * The title a line-link chip shows. A copied line link is labeled
 * `Doc › L3–5`, and the chip draws the range as its own badge, so a label
 * ending in ` › ` plus the same range shows as `Doc` and the range shows once.
 * Any other label (another range, a section name, the range alone) is kept.
 */
export function chipTitleWithoutRange(title: string, anchor: DocAnchor | undefined): string {
  if (!anchor || !('lines' in anchor)) return title;
  const cut = title.lastIndexOf(' › ');
  if (cut <= 0) return title;
  const named = parseLineFragment(title.slice(cut + 3));
  const { lines } = anchor;
  const same =
    named !== null &&
    named.startLine === lines.startLine &&
    named.endLine === lines.endLine &&
    named.startChar === lines.startChar &&
    named.endChar === lines.endChar;
  return same ? title.slice(0, cut) : title;
}
