// kinds.ts — per-kind metadata: URL scheme used for chip hrefs,
// transclusion eligibility, and display fallbacks. Single source of
// truth — keep in lock-step with the server's content-ref parser at
// apps/server/src/services/contentRefs.ts.

import { RETIRED_ID_PREFIXES } from '@snaglet/shared/constants/nodeKinds';
import type { ChipKind } from './payload';

/** Drag payload kind → URL scheme used in chip hrefs. Doc maps to the
 *  `page:<uuid>` scheme; everything else is identity. */
export const KIND_TO_SCHEME: Record<ChipKind, string> = {
  doc: 'page',
  thread: 'thread',
  container: 'container',
  project: 'project',
  memory: 'memory',
  thread_summary: 'thread_summary',
  message: 'message',
  model: 'model',
  tool: 'tool',
  // Agent chips never use this scheme — chipHrefForNode emits the bare
  // agent slug (parseNodeRef resolves it via the agents cache, same as
  // the @-mention insert path) — but the map must be total over ChipKind.
  agent: 'agent',
  // Image chips carry the prefixed id (`image-…`), so chipHrefForNode
  // emits the bare id and this scheme is never actually used — but the map
  // must be total over ChipKind.
  image: 'image',
  sketch: 'sketch',
  post: 'post',
  file: 'file',
  // file/folder chips don't actually use these schemes — chipHrefForNode emits
  // their path-encoded `file:`/`folder:` href directly — but the map must be
  // total over ChipKind.
  folder: 'folder',
  // Runs are execution history, not workspace nodes (no `run` member in
  // `public.node_type`), so this scheme is never resolved by the server's
  // content-ref harvester and a run chip forms no `links` edge. The entry
  // exists because the map must be total over ChipKind; the value matches the
  // `run:<id>` text/plain convention used for drags into external apps.
  run: 'run',
  // Catalog ids are not node ids, so a table chip always takes the dedicated
  // `table:<catalog id>` href (see chipHrefForNode / parseNodeRef).
  table: 'table',
  entry: 'entry',
  // Member ids are `public.members` UUIDs, not node ids; the dedicated
  // `member:<id>` href keeps them out of every node-id grammar. The server's
  // content-ref harvester ignores the scheme, so a member chip forms no
  // `links` edge.
  member: 'member',
};

/** Kinds that render as full content inclusion when the chip uses the
 *  `![](href)` grammar. Today only documents can be transcluded — every
 *  other kind degrades to a link chip even with the `!` prefix. */
const INCLUDABLE_KINDS: ReadonlySet<ChipKind> = new Set<ChipKind>(['doc']);

export const isIncludableKind = (kind: ChipKind): boolean => INCLUDABLE_KINDS.has(kind);

/** Display fallback when a node has no usable title or name (drafts,
 *  in-flight renames, server-side null titles). */
const KIND_FALLBACK_TITLE: Record<ChipKind, string> = {
  doc: 'Untitled doc',
  thread: 'Untitled thread',
  container: 'Container',
  project: 'Project',
  memory: 'Memory',
  thread_summary: 'Thread summary',
  message: 'Message',
  model: 'Model',
  tool: 'Tool',
  agent: 'Agent',
  image: 'Image',
  sketch: 'Sketch',
  post: 'Post',
  file: 'File',
  folder: 'Folder',
  run: 'Run',
  table: 'Table',
  entry: 'Untitled',
  member: 'Member',
};

export const fallbackTitleForKind = (kind: ChipKind): string => KIND_FALLBACK_TITLE[kind];

/** A kind with no feature behind it (`sketch`, `post`): the chip keeps its
 *  label but has nothing to open, so it renders as unavailable. */
export const isRetiredKind = (kind: string): boolean => RETIRED_ID_PREFIXES.has(kind);
