import type {
  LibraryTreeChild,
  PaletteEntryHit,
  PaletteNodeKind,
  PaletteSearchChannel,
  PaletteSearchHit,
} from '@desktop/utils/api';
import { extractThreadSummaryDisplay } from '@desktop/utils/threadSummaryHit';

type LibraryKind = LibraryTreeChild['kind'];
/**
 * A palette result kind: a server/node kind, or `entry` — a table row, found
 * by `entry:` or the unfiltered search's short Entries section. Entries are
 * palette-only: they are not a `PaletteNodeKind`, so the tree search and
 * @-mentions, which share that list, never see them.
 */
export type Kind = PaletteNodeKind | 'entry';
type AuxiliaryKind = Exclude<PaletteNodeKind, LibraryKind>;

interface AuxiliarySearchNode {
  kind: AuxiliaryKind;
  id: string;
  title: string;
  payload: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A table row. `id` is the entry's UUID; `tableId` its table's catalog id. */
export interface EntrySearchNode {
  kind: 'entry';
  id: string;
  tableId: string;
  tableName: string;
  /** The entry's Name ('' when it has none). */
  name: string;
  createdAt: string | null;
  updatedAt: null;
}

export type PaletteResultNode = LibraryTreeChild | AuxiliarySearchNode | EntrySearchNode;

export interface SearchResult {
  node: PaletteResultNode;
  label: string;
  /** Display-friendly kind label */
  kindLabel: string;
  origin: 'lexical' | 'server';
  channels: PaletteSearchChannel[];
  /** ISO timestamp when the underlying node was created, if known. */
  createdAt: string | null;
  /** ISO timestamp when the underlying node was last updated, if known. */
  updatedAt: string | null;
  /** Where the result lives (`resultLocation` in paletteLocation.ts), set by the search hook. */
  location?: string | null;
}

export interface SearchSection {
  id: string;
  label: string;
  origin: SearchResult['origin'];
  results: SearchResult[];
}

const KIND_LABELS: Record<Kind, string> = {
  container: 'Container',
  doc: 'Doc',
  thread: 'Thread',
  message: 'Message',
  image: 'Image',
  memory: 'Memory',
  thread_summary: 'Summary',
  tool: 'Tool',
  agent: 'Agent',
  table: 'Table',
  entry: 'Entry',
};

export const KIND_SECTION_LABELS: Record<Kind, string> = {
  container: 'Containers',
  doc: 'Docs',
  thread: 'Threads',
  message: 'Messages',
  image: 'Images',
  memory: 'Memories',
  thread_summary: 'Thread summaries',
  tool: 'Tools',
  agent: 'Agents',
  table: 'Tables',
  entry: 'Entries',
};

/** Extract the human-readable label for any node kind. */
export function labelOf(node: PaletteResultNode): string {
  switch (node.kind) {
    case 'container':
      return node.name;
    case 'doc':
      return node.title || 'Untitled';
    case 'thread':
      return node.title || 'Untitled thread';
    case 'image':
      return node.name || 'Untitled image';
    case 'message':
    case 'memory':
    case 'thread_summary':
    case 'tool':
    case 'agent':
    case 'table':
      return node.title;
    case 'entry':
      // `<row name> · <table name>`: rows of different tables often share names.
      return `${node.name.trim() || 'Untitled'} · ${node.tableName}`;
    default: {
      // Unknown / deleted kind — best-effort label so a stale result renders
      // something readable instead of throwing on an unhandled branch.
      const anyNode = node as { title?: string; name?: string; id?: string };
      return anyNode.title || anyNode.name || anyNode.id || 'Untitled';
    }
  }
}

/**
 * Extract `createdAt` / `updatedAt` ISO strings off any palette node, when they exist.
 * Server-hydrated auxiliary nodes carry timestamps on the payload, so promote
 * them onto the node shape when building those lightweight result records.
 */
function timestampsOf(node: PaletteResultNode): {
  createdAt: string | null;
  updatedAt: string | null;
} {
  const anyNode = node as unknown as {
    createdAt?: string | null;
    updatedAt?: string | null;
  };
  return {
    createdAt: anyNode.createdAt ?? null,
    updatedAt: anyNode.updatedAt ?? null,
  };
}

function payloadString(payload: Record<string, unknown>, key: string, fallback = ''): string {
  return typeof payload[key] === 'string' ? payload[key] : fallback;
}

function payloadNullableString(payload: Record<string, unknown>, key: string): string | null {
  return typeof payload[key] === 'string' ? payload[key] : null;
}

function payloadNumber(payload: Record<string, unknown>, key: string): number {
  return typeof payload[key] === 'number' ? payload[key] : 0;
}

function auxiliaryNode(hit: PaletteSearchHit, title: string): AuxiliarySearchNode {
  const createdAt = payloadNullableString(hit.payload, 'createdAt');
  const updatedAt = payloadNullableString(hit.payload, 'updatedAt');
  return {
    kind: hit.kind as AuxiliaryKind,
    id: hit.node_id,
    title,
    payload: hit.payload,
    createdAt,
    updatedAt,
  };
}

export function serverHitToNode(hit: PaletteSearchHit): PaletteResultNode {
  const payload = hit.payload;
  const createdAt = payloadString(payload, 'createdAt');
  const updatedAt = payloadString(payload, 'updatedAt');

  switch (hit.kind) {
    case 'container':
      return {
        kind: 'container',
        id: hit.node_id,
        parentId: payloadNullableString(payload, 'containerId'),
        name: payloadString(payload, 'name', 'Untitled container'),
        sortOrder: payloadNumber(payload, 'sortOrder'),
        category: null,
        folderPath: null,
        githubUrl: null,
        children: [],
        createdAt,
        updatedAt,
      };
    case 'doc':
      return {
        kind: 'doc',
        id: hit.node_id,
        containerId: payloadNullableString(payload, 'containerId'),
        title: payloadString(payload, 'title', 'Untitled'),
        content: '',
        sortOrder: payloadNumber(payload, 'sortOrder'),
        createdAt,
        updatedAt,
      };
    case 'thread': {
      const projectId = payloadNullableString(payload, 'projectId');
      return {
        kind: 'thread',
        id: hit.node_id,
        projectId,
        title: payloadNullableString(payload, 'title'),
        sortOrder: payloadNumber(payload, 'sortOrder'),
        lastMessageAt: payloadNullableString(payload, 'lastMessageAt'),
        createdAt,
        updatedAt,
      };
    }
    case 'message':
      return auxiliaryNode(
        hit,
        payloadString(payload, 'title', payloadString(payload, 'content', 'Message'))
      );
    case 'image':
      return {
        kind: 'image',
        id: hit.node_id,
        containerId: payloadNullableString(payload, 'containerId'),
        name: payloadString(payload, 'name', 'Untitled image'),
        description: payloadNullableString(payload, 'description'),
        tags: Array.isArray(payload.tags)
          ? payload.tags.filter((t): t is string => typeof t === 'string')
          : [],
        mimeType: payloadString(payload, 'mimeType', 'application/octet-stream'),
        sizeBytes: payloadNumber(payload, 'sizeBytes'),
        sortOrder: payloadNumber(payload, 'sortOrder'),
        url: `/api/images/${hit.node_id}/content`,
        createdAt: createdAt ?? '',
        updatedAt: updatedAt ?? '',
      };
    case 'memory':
      return auxiliaryNode(hit, payloadString(payload, 'title', 'Memory'));
    case 'thread_summary':
      // The server returns `payload.title = 'Thread summary'` for every row;
      // surface the actual matched summary preview as the result title so
      // the user can tell summaries apart. The full payload still travels
      // along the node so CommandPalette can render the parent-thread label.
      return auxiliaryNode(hit, extractThreadSummaryDisplay(payload).preview);
    case 'tool':
      return auxiliaryNode(hit, payloadString(payload, 'name', 'Tool'));
    case 'agent':
      return auxiliaryNode(hit, payloadString(payload, 'name', 'Agent'));
    case 'table':
      // `node_id` is the catalog id — tables are not workspace nodes.
      return auxiliaryNode(
        hit,
        payloadString(payload, 'name', payloadString(payload, 'title', 'Table'))
      );
    default:
      // Unknown / deleted kind from a stale index row — degrade to a generic
      // auxiliary node rather than returning `undefined` (which would throw
      // downstream in `toSearchResult`).
      return auxiliaryNode(
        hit,
        payloadString(payload, 'title', payloadString(payload, 'name', 'Result'))
      );
  }
}

/** A server entry hit as a palette node. */
export function entryHitToNode(hit: PaletteEntryHit): EntrySearchNode {
  return {
    kind: 'entry',
    id: hit.entryId,
    tableId: hit.tableId,
    tableName: hit.tableName,
    name: hit.name,
    createdAt: hit.createdAt || null,
    updatedAt: null,
  };
}

export function toSearchResult(
  node: PaletteResultNode,
  origin: SearchResult['origin'],
  channels: PaletteSearchChannel[] = []
): SearchResult {
  const { createdAt, updatedAt } = timestampsOf(node);
  return {
    node,
    label: labelOf(node),
    // Guard: a deleted kind falls back to the raw kind string rather than
    // rendering `undefined` in the result badge.
    kindLabel: KIND_LABELS[node.kind] ?? node.kind,
    origin,
    channels,
    createdAt,
    updatedAt,
  };
}
