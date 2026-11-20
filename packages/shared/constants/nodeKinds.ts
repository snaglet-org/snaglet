/**
 * Canonical node-kind taxonomies shared between client and server.
 *
 * Declared once here because client and server must stay in lockstep
 * (apps/desktop-ui/src/utils/api/palette-search.ts and
 * apps/server/src/services/search/paletteSearch.ts both consume these).
 * Drift silently breaks the Cmd+K palette: a kind added on one side and not the other will
 * either fail the client filter or be missing from the server query.
 *
 * This module is the single source of truth. Both sides must import from
 * here; do not redeclare these arrays elsewhere.
 */

/** Single constant per node kind — use instead of bare string literals.
 *  Note: 'agent' is not a node kind — agents are
 *  actors, not nodes. It survives only as a PALETTE result kind below. */
export const NODE_KIND = {
  CONTAINER: 'container',
  DOC: 'doc',
  FILE: 'file',
  IMAGE: 'image',
  MEMORY: 'memory',
  MESSAGE: 'message',
  THREAD: 'thread',
  THREAD_SUMMARY: 'thread_summary',
  TOOL: 'tool',
} as const;

export type NodeKind = (typeof NODE_KIND)[keyof typeof NODE_KIND];

/**
 * The set of result kinds the global palette search (Cmd+K) can return.
 *
 * Superset of `WorkspaceNodeKind` (which covers only the workspace tree
 * surfaces — containers, docs, threads). The palette additionally
 * surfaces conversational and platform results (messages, tools, memories,
 * thread summaries) plus 'agent' — an ACTOR result kind, not a node kind:
 * agents are found by name lookup against the agents table (they have no node
 * row). 'table' is likewise not a node kind: a Database table is found by
 * name lookup against `public.table_catalog` and keyed by its catalog id.
 * Projects are likewise not a node kind — a
 * project is a container with `category='project'`, found via `container`.
 *
 * Declared `as const` so `PaletteNodeKind` is a string-literal union, not
 * `string`, preserving exhaustiveness checks at consumer call sites.
 */
export const PALETTE_NODE_KINDS = [
  NODE_KIND.CONTAINER,
  NODE_KIND.DOC,
  NODE_KIND.THREAD,
  NODE_KIND.MESSAGE,
  NODE_KIND.IMAGE,
  NODE_KIND.MEMORY,
  NODE_KIND.THREAD_SUMMARY,
  NODE_KIND.TOOL,
  'agent',
  'table',
] as const;

export type PaletteNodeKind = (typeof PALETTE_NODE_KINDS)[number];

/**
 * Id-prefix vocabulary. Node ids are `<prefix>-<body>` where the prefix is
 * the kind name, so `NODE_KIND` doubles as the live-prefix source. The two
 * groups below cover ids that are not live node kinds but still appear in
 * stored content and must stay recognizable.
 *
 * Consumers (the palette id detector, the outbound linter, linkForm, the
 * chip-URL parser) each recognize a DIFFERENT, deliberate subset — e.g. the
 * linter only lists kinds it can verify in the `nodes` table, so `agent`
 * (an actor, not a node) is excluded there. Build each subset from these
 * named constants rather than restating the strings, so a new kind cannot
 * silently miss one of the sites.
 */

/** Agents are actors (a table), not nodes — but `agent-…` ids circulate. */
export const AGENT_ID_PREFIX = 'agent';

/**
 * Prefixes minted by kinds that no longer exist. Converted rows keep their
 * original ids forever (a task-doc stays `task-…`), so these must be
 * recognized wherever ids are parsed — but never minted or offered as kinds.
 */
export const LEGACY_ID_PREFIX = {
  TASK: 'task',
  PAGE: 'page',
  LIBRARY_NODE: 'library_node',
  PROJECT: 'project',
  /**
   * Sketch nodes no longer exist, but `sketch-…` ids may still appear in doc
   * and message content, so the prefix stays recognized (and renders as an
   * unresolved workspace item) but is never minted or offered as a live kind.
   */
  SKETCH: 'sketch',
  /**
   * Board posts and discussions no longer exist; `post-…` ids are handled
   * like `sketch-…` ids.
   */
  POST: 'post',
} as const;

/**
 * Prefixes of removed features: still parsed so old chips keep a label and a
 * pill, but there is no row to open — the UI shows them as unavailable.
 */
export const RETIRED_ID_PREFIXES: ReadonlySet<string> = new Set<string>([
  LEGACY_ID_PREFIX.SKETCH,
  LEGACY_ID_PREFIX.POST,
]);

/**
 * Regex alternation for a prefix subset. Order is preserved — put longer
 * prefixes before their own prefixes (`thread_summary` before `thread`)
 * when the pattern is not anchored by a delimiter.
 */
export const idPrefixAlternation = (prefixes: readonly string[]): string => prefixes.join('|');
