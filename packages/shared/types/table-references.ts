/**
 * Database tables — relation fields that link to Snaglet's own items (wire contract).
 *
 * A relation field links to exactly one target: a custom table
 * (`referenceTableId`) or one built-in Snaglet item kind (`referenceKind`). The
 * kinds are a closed allowlist, enforced again by a CHECK constraint; each
 * has a fixed resolver in the DB layer that returns
 * only an id, a title and a context line, never content, prompts or secrets.
 * See docs/architecture.md.
 */

/**
 * Built-in item kinds a relation may link to. `project` is a container whose
 * category is `project`;
 * `member` is a workspace member (a human or an agent's actor row), so an
 * assignee relation can point at a person, not only an agent.
 */
export const TABLE_REFERENCE_KINDS = [
  'doc',
  'project',
  'container',
  'thread',
  'image',
  'agent',
  'member',
] as const;
export type TableReferenceKind = (typeof TABLE_REFERENCE_KINDS)[number];

/** How messages and pickers name one item of a kind, and several. */
export const TABLE_REFERENCE_KIND_NAMES: Readonly<
  Record<TableReferenceKind, { singular: string; plural: string }>
> = {
  doc: { singular: 'doc', plural: 'docs' },
  project: { singular: 'project', plural: 'projects' },
  container: { singular: 'container', plural: 'containers' },
  thread: { singular: 'thread', plural: 'threads' },
  image: { singular: 'image', plural: 'images' },
  agent: { singular: 'agent', plural: 'agents' },
  member: { singular: 'member', plural: 'members' },
};

/**
 * The shape every stored Snaglet item id must have. Node ids are prefixed
 * (`doc-…`, `container-…`); agent ids are name slugs (`test-agent-a`).
 */
export const TABLE_REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** A linked item as entry reads name it. */
export interface TableReferenceItem {
  /** The item's title (a thread without one is "Untitled thread"). */
  title: string;
  /** Archived items stay linked and show as archived; restoring brings them back. */
  archived: boolean;
}

/**
 * Titles of the Snaglet items that kind relation values point at, keyed by kind
 * and then item id. Items that no longer exist (purged) are absent, so their
 * ids read as unavailable.
 */
export type RelatedTableItems = Partial<
  Record<TableReferenceKind, Record<string, TableReferenceItem>>
>;

/** GET /api/tables/references/search */
export interface TableReferenceSearchQuery {
  kind: TableReferenceKind;
  /** Trimmed, at most 200 characters; empty lists the most recently updated items. */
  q?: string;
  /** 1–50, default 20. */
  limit?: number;
  /** Results to skip, 0–10,000, default 0. */
  offset?: number;
  /** Item ids left out of the results, e.g. ones a relation already links (at most 100). */
  exclude?: string[];
}

export interface TableReferenceSearchResult {
  id: string;
  title: string;
  /** The parent container's name, or an agent's or member's role; null when there is none. */
  context: string | null;
}

export interface TableReferenceSearchResponse {
  /** Live (not archived) items only, best match first. */
  results: TableReferenceSearchResult[];
  /** More matches follow; ask again with `offset` advanced by `results.length`. */
  hasMore: boolean;
}
