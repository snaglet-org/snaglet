/**
 * linkForm — canonical "ready to paste" markdown link string for an node.
 *
 * Tools that return nodes (workspace_search, etc.) include a
 * `link_form` field on each result row. Agents copy that string
 * verbatim into content; the system extracts these markdown links into the
 * `links` graph automatically (see `services/contentRefs.ts`).
 *
 * Two output shapes, chosen based on the id format:
 *   - Prefixed id (`doc-…`, `thread-…`, etc.): `[Title](<id>)`; the prefix on
 *     the id already identifies the node type, so the scheme is omitted.
 *   - Bare UUID (still present in older content): `[Title](<scheme>:<uuid>)`.
 */

import type { LinkNodeType } from '@snaglet/db/tables/links';
import {
  AGENT_ID_PREFIX,
  idPrefixAlternation,
  LEGACY_ID_PREFIX,
  NODE_KIND,
} from '@snaglet/shared/constants/nodeKinds';

/**
 * Types `linkForm` accepts. `sketch` is not a `LinkNodeType` (that list is
 * the `<scheme>:<uuid>` namespace for bare UUIDs, and every sketch id is
 * prefixed), but sketch ids are link targets, so tools that emit
 * `[Title](sketch-…)` go through here like every other kind instead of
 * hand-rolling the markdown.
 *
 * `image` ids are prefixed too, and content refs already parse
 * `[Title](image-…)`.
 */
export type LinkFormType =
  | LinkNodeType
  // `sketch-…` ids still appear in older content; the prefix is kept so such a
  // link stays self-identifying.
  | typeof LEGACY_ID_PREFIX.SKETCH
  | typeof NODE_KIND.IMAGE;

const FALLBACK_TITLE: Partial<Record<LinkFormType, string>> = {
  doc: 'Untitled Doc',
  page: 'Untitled Doc', // `page:` scheme alias for doc
  thread: 'Thread',
  thread_summary: 'Thread Summary',
  sketch: 'Untitled Sketch',
  image: 'Untitled image',
};

/**
 * Matches any id whose prefix corresponds to a `public.node_type`, which
 * decides whether the id is already self-identifying and the `<scheme>:`
 * prefix can be dropped.
 *
 * `task` is not a `public.node_type`, but docs converted from tasks keep their
 * `task-…` ids, so that prefix still counts as self-identifying (no `doc:`
 * scheme).
 */
const PREFIXED_NODE_ID_RE = new RegExp(
  `^(?:${idPrefixAlternation([
    NODE_KIND.THREAD_SUMMARY,
    NODE_KIND.CONTAINER,
    NODE_KIND.MESSAGE,
    NODE_KIND.MEMORY,
    NODE_KIND.THREAD,
    LEGACY_ID_PREFIX.SKETCH,
    AGENT_ID_PREFIX,
    NODE_KIND.IMAGE,
    LEGACY_ID_PREFIX.TASK,
    NODE_KIND.DOC,
    NODE_KIND.FILE,
  ])})-`
);

/**
 * Build the canonical markdown link for an node. Escapes `]` and `\`
 * inside the title so a corrupted title can't break the markdown grammar.
 */
export function linkForm(type: LinkFormType, id: string, title: string | null | undefined): string {
  const text = (title ?? '').trim() || FALLBACK_TITLE[type] || 'Reference';
  const safe = text.replace(/[\]\\]/g, '\\$&');
  if (PREFIXED_NODE_ID_RE.test(id)) return `[${safe}](${id})`;
  return `[${safe}](${type}:${id})`;
}
