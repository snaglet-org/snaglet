import { isRecord, safeJsonParse } from '@snaglet/shared/utils';
import { PANE_ITEM_MIME } from '../paneDrag';

/** MIME used on the DataTransfer for node-chip drags. */
export const NODE_CHIP_MIME = 'application/x-snaglet-node-chip';

export type ChipKind =
  | 'container'
  | 'doc'
  | 'thread'
  | 'project'
  | 'memory'
  | 'thread_summary'
  | 'message'
  | 'model'
  | 'tool'
  | 'agent'
  | 'file'
  | 'folder'
  | 'image'
  // Kinds with no feature behind them. Saved content can still hold
  // `sketch-…` / `post-…` ids; these render as unavailable pills, not raw text.
  | 'sketch'
  | 'post'
  // Execution history, not a workspace node: there is no `run` member in
  // `public.node_type`, so a run chip is a drag/insert payload only — it never
  // resolves to a `public.nodes` row and never forms a `links` edge.
  | 'run'
  // Database catalog table, keyed by its catalog id (`table-builtin-…` /
  // `table-<ts>-…`). Not a workspace node: it never goes through node lookups
  // and forms no `links` edge.
  | 'table'
  | 'entry'
  // Workspace member (a `public.members` row: a human, an agent's principal
  // or an external MCP client), as a table relation of kind `member` links
  // it. Not a workspace node: the chip names the member and opens nothing.
  | 'member';

const CHIP_KINDS: ReadonlySet<string> = new Set<ChipKind>([
  'container',
  'doc',
  'thread',
  'project',
  'memory',
  'thread_summary',
  'message',
  'model',
  'tool',
  'agent',
  'file',
  'folder',
  'image',
  'sketch',
  'post',
  'run',
  'table',
  'entry',
  'member',
]);

export const isChipKind = (k: string | null | undefined): k is ChipKind =>
  typeof k === 'string' && CHIP_KINDS.has(k);

export interface NodeChipData {
  id: string;
  kind: ChipKind;
  title?: string | null;
  name?: string | null;
}

// In-memory drag store
//
// Tauri's WKWebView (macOS) silently swallows DataTransfer.setData() calls
// for custom MIME types, and sometimes even text/plain does not survive the
// dragover -> drop boundary. We keep the active chip in a module-level
// variable for the lifetime of a single drag gesture:
//   dragstart -> writeChipDragData  sets _activeDragChip
//   dragend   -> chipDragSource clears it via setActiveDragChip(null)
//   drop      -> readChipDragData checks _activeDragChip first
let _activeDragChip: NodeChipData | null = null;

export const setActiveDragChip = (chip: NodeChipData | null): void => {
  _activeDragChip = chip;
};
export const getActiveDragChip = (): NodeChipData | null => _activeDragChip;

// The same store for a multi-row drag's full chip list (see "Multi-item
// drags" below), scoped to the gesture the same way.
let _activeDragChipList: ChipDragList | null = null;

export const setActiveDragChipList = (list: ChipDragList | null): void => {
  _activeDragChipList = list;
};

// The store must never outlive the drag that wrote it: a stale chip would be
// served first on the next, unrelated drag and insert the wrong item. Sources
// may forget to clear it, or the source may unmount before dragend, so
// capture-phase window listeners clear it too. On dragstart they run before
// any source's own handler (capture precedes React's bubble-phase handlers),
// so each gesture starts clean and its own write survives; on dragend they
// fire even when a drop handler stopped propagation.
const clearDragStores = (): void => {
  setActiveDragChip(null);
  setActiveDragChipList(null);
};
if (typeof window !== 'undefined') {
  window.addEventListener('dragstart', clearDragStores, true);
  window.addEventListener('dragend', clearDragStores, true);
}

export const NODE_CHIP_TEXT_PREFIX = '__snaglet_chip__:';

/** Plain-text scheme emitted for run chips dragged into external apps. */
const RUN_TEXT_PREFIX = 'run:';

/**
 * Run chips carry an id people paste into terminals and logs, so their
 * `text/plain` flavor is the bare `run:<id>` scheme rather than the
 * `__snaglet_chip__:{json}` envelope other kinds use. `readChipDragData` parses it
 * back, so a run chip still round-trips when text/plain is the only flavor
 * that survives (WKWebView).
 */
const runPlainText = (node: NodeChipData): string => `${RUN_TEXT_PREFIX}${node.id}`;

/** Strict UUID match — run ids are `randomUUID()` values (turnLoop.ts). */
const RUN_PLAIN_TEXT_RE =
  /^run:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** Parse the `run:<uuid>` plain-text flavor back to a bare run id. */
export const parseRunPlainText = (text: string | null | undefined): string | null => {
  if (!text) return null;
  const match = RUN_PLAIN_TEXT_RE.exec(text.trim());
  return match ? match[1] : null;
};

export const writeChipDragData = (dt: DataTransfer, node: NodeChipData): void => {
  _activeDragChip = node;
  const json = JSON.stringify(node);
  try {
    dt.setData(NODE_CHIP_MIME, json);
  } catch {
    /* WKWebView may throw */
  }
  try {
    dt.setData(
      'text/plain',
      node.kind === 'run' ? runPlainText(node) : `${NODE_CHIP_TEXT_PREFIX}${json}`
    );
  } catch {
    /* noop */
  }
};

export const readChipDragData = (dt: DataTransfer): NodeChipData | null => {
  // 1. In-memory store (Tauri same-page — always works)
  if (_activeDragChip) return _activeDragChip;

  // 2. Canonical MIME
  const chipRaw = dt.getData(NODE_CHIP_MIME);
  if (chipRaw) {
    const parsed = safeJsonParse<NodeChipData | null>(chipRaw, null);
    if (parsed && typeof parsed.id === 'string' && isChipKind(parsed.kind)) return parsed;
  }

  // 3. Pane-item MIME — workspace selection shapes (`{ kind: 'doc', doc_id,
  //    node? }`, `thread`, `container`, ...). Title/name come from the
  //    optional `node` when present; otherwise a minimal chip is built from
  //    the discriminant id.
  const paneRaw = dt.getData(PANE_ITEM_MIME);
  if (paneRaw) {
    try {
      const payload = safeJsonParse<{
        kind?: string;
        doc_id?: string;
        task_id?: string;
        thread_id?: string;
        container_id?: string;
        project_id?: string;
        node?: { id?: string; kind?: string; title?: string | null; name?: string | null };
      }>(paneRaw, {});

      // Agent rows (AgentsList) drag `{ kind: 'agent', agent: { id, name } }`
      // — a nested principal, not a flat id field. Agents aren't workspace
      // nodes, but they are chips (bare-slug href, same as the @-mention
      // path in ChipEditableInput).
      if (payload.kind === 'agent') {
        const agent = (payload as { agent?: { id?: string; name?: string | null } }).agent;
        if (agent && typeof agent.id === 'string') {
          return {
            id: agent.id,
            kind: 'agent',
            title: agent.name ?? null,
            name: agent.name ?? null,
          };
        }
      }

      // Table rows (the workspace tree's Tables groups) drag the table pane selection
      // `{ kind: 'table', table_id, table? }` — a catalog id plus an optional
      // catalog entry, not a workspace node, so the title comes from
      // `table.name`.
      if (payload.kind === 'table') {
        const { table_id: tableId, table } = payload as {
          table_id?: string;
          table?: { name?: string | null };
        };
        if (typeof tableId === 'string') {
          const name = table?.name ?? null;
          return { id: tableId, kind: 'table', title: name, name };
        }
      }

      // Map discriminant -> chip kind + id, preferring the
      // optional `node` payload for title/name when present.
      const FLAT_ID_FIELD: Record<string, keyof typeof payload> = {
        doc: 'doc_id',
        thread: 'thread_id',
        container: 'container_id',
        project: 'project_id',
      };
      const idField = payload.kind ? FLAT_ID_FIELD[payload.kind] : undefined;
      if (payload.kind && idField && isChipKind(payload.kind)) {
        const id = payload[idField] as string | undefined;
        if (typeof id === 'string') {
          return {
            id,
            kind: payload.kind,
            title: payload.node?.title ?? null,
            name: payload.node?.name ?? null,
          };
        }
      }
    } catch {
      /* noop */
    }
  }

  // 4. text/plain fallback
  const textRaw = dt.getData('text/plain');
  if (textRaw && textRaw.startsWith(NODE_CHIP_TEXT_PREFIX)) {
    const parsed = safeJsonParse<NodeChipData | null>(
      textRaw.slice(NODE_CHIP_TEXT_PREFIX.length),
      null
    );
    if (parsed && typeof parsed.id === 'string' && isChipKind(parsed.kind)) return parsed;
  }

  // 5. Run chips use the bare `run:<uuid>` plain-text scheme (see
  //    writeChipDragData). Parse it back so a run still round-trips when
  //    text/plain is the only flavor that survived. The id is matched
  //    strictly as a UUID so unrelated prose beginning "run:" is not
  //    mistaken for a chip. Title is unknown from this flavor alone —
  //    same-page drags recover it from the in-memory store above.
  const runId = parseRunPlainText(textRaw);
  if (runId) return { id: runId, kind: 'run', title: null, name: null };

  return null;
};

export const hasChipDragData = (dt: DataTransfer): boolean => {
  // In-memory store set at dragstart — works even when DataTransfer.types is empty in WKWebView
  if (_activeDragChip || _activeDragChipList) return true;
  if (
    dt.types.includes(NODE_CHIP_MIME) ||
    dt.types.includes(NODE_CHIP_LIST_MIME) ||
    dt.types.includes(PANE_ITEM_MIME)
  )
    return true;
  if (dt.types.includes('text/plain')) {
    const textRaw = dt.getData('text/plain');
    if (textRaw === '' || textRaw.startsWith(NODE_CHIP_TEXT_PREFIX)) return true;
    // Run chips ship the bare `run:<uuid>` scheme instead of the JSON
    // envelope, so recognize it here too or drop targets reject the drag.
    if (parseRunPlainText(textRaw)) return true;
  }
  return false;
};

// Multi-item drags
//
// A sidebar drag that starts on a row of a multi-selection carries every
// selected row, in sidebar order. The single-chip flavors above still name
// the row under the pointer for consumers that take one item; inputs that
// take several read the list with `readChipDragList`.

/** MIME for a multi-row drag's full chip list (`encodeChipDragList`). */
export const NODE_CHIP_LIST_MIME = 'application/x-snaglet-node-chip-list';

export interface ChipDragList {
  /** The dragged items that have a chip form, in selection order. */
  chips: NodeChipData[];
  /** Dragged items with no chip form, so a drop can say it skipped them. */
  unlinkable: number;
}

interface DraggedItem {
  id: string;
  kind: string;
  title?: string | null;
}

/** The chip list for dragged rows; a kind with no chip form counts as unlinkable. */
export const chipDragListOf = (items: readonly DraggedItem[]): ChipDragList => {
  const chips: NodeChipData[] = [];
  for (const { id, kind, title } of items) {
    if (isChipKind(kind)) chips.push({ id, kind, title: title ?? null });
  }
  return { chips, unlinkable: items.length - chips.length };
};

/** True when the drag carried more than one item, linkable or not. */
export const isMultiChipDrag = (list: ChipDragList): boolean =>
  list.chips.length + list.unlinkable > 1;

export const encodeChipDragList = (list: ChipDragList): string => JSON.stringify(list);

/** Parse an encoded list. Entries that are not valid chips count as unlinkable. */
export const decodeChipDragList = (raw: string | null | undefined): ChipDragList | null => {
  if (!raw) return null;
  const parsed = safeJsonParse<unknown>(raw, null);
  if (!isRecord(parsed) || !Array.isArray(parsed.chips)) return null;
  const chips: NodeChipData[] = [];
  for (const entry of parsed.chips) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.kind !== 'string') {
      continue;
    }
    if (!isChipKind(entry.kind)) continue;
    chips.push({
      id: entry.id,
      kind: entry.kind,
      title: typeof entry.title === 'string' ? entry.title : null,
      ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
    });
  }
  const declared =
    typeof parsed.unlinkable === 'number' && Number.isInteger(parsed.unlinkable)
      ? Math.max(0, parsed.unlinkable)
      : 0;
  const unlinkable = declared + (parsed.chips.length - chips.length);
  return chips.length + unlinkable > 0 ? { chips, unlinkable } : null;
};

/** Attach a multi-row drag's chip list (in-memory store + MIME, like the single chip). */
export const writeChipDragList = (dt: DataTransfer, list: ChipDragList): void => {
  _activeDragChipList = list;
  try {
    dt.setData(NODE_CHIP_LIST_MIME, encodeChipDragList(list));
  } catch {
    /* WKWebView may throw — the in-memory store still carries the list */
  }
};

/**
 * Every item a drop carries, in selection order: the multi-row list when the
 * drag wrote one, else the single chip `readChipDragData` finds. `null` when
 * the drag carries no chip at all.
 */
export const readChipDragList = (dt: DataTransfer): ChipDragList | null => {
  if (_activeDragChipList) return _activeDragChipList;
  const decoded = decodeChipDragList(dt.getData(NODE_CHIP_LIST_MIME));
  if (decoded) return decoded;
  const chip = readChipDragData(dt);
  return chip ? { chips: [chip], unlinkable: 0 } : null;
};
