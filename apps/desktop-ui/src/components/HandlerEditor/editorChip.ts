/**
 * Drag payload for the chip palette above the code editor (agent, tool,
 * thread and workspace-node id chips).
 *
 * The MIME type is deliberately separate from `PANE_ITEM_MIME` and
 * `NODE_CHIP_MIME`: usePaneDropZone only reacts to drags that carry
 * `PANE_ITEM_MIME`, so a chip drag never triggers a pane split.
 */
import type { DragEvent as ReactDragEvent } from 'react';
import { safeJsonParse } from '@snaglet/shared/utils';

/** MIME used on the DataTransfer for chip-palette drags. */
export const EDITOR_CHIP_MIME = 'application/x-snaglet-editor-chip';

const TEXT_PREFIX = '__snaglet_editor_chip__:';

export interface EditorChipPayload {
  /** Exact, already-quoted literal to insert into the code editor (e.g.
   *  `'message:create'` or `'tool-abc123'`) — the chip computes this, not
   *  the drop target, so drag and click always insert identically. */
  text: string;
  /** Optional label for the drag ghost / debugging. Not required for insertion. */
  label?: string;
}

// In-memory drag fallback
//
// Mirrors utils/nodeChip/payload.ts's `_activeDragChip` — Tauri's WKWebView
// (macOS) is known to silently drop DataTransfer.setData() calls for custom
// MIME types across the dragover -> drop boundary. Keeping the active
// payload in a module-level variable for the drag gesture's lifetime is the
// same defense that module uses.
let _activeChip: EditorChipPayload | null = null;

export function writeEditorChipDragData(dt: DataTransfer, payload: EditorChipPayload): void {
  _activeChip = payload;
  const json = JSON.stringify(payload);
  try {
    dt.setData(EDITOR_CHIP_MIME, json);
  } catch {
    /* WKWebView may throw on custom MIME types */
  }
  try {
    dt.setData('text/plain', `${TEXT_PREFIX}${json}`);
  } catch {
    /* noop */
  }
}

export function readEditorChipDragData(dt: DataTransfer): EditorChipPayload | null {
  if (_activeChip) return _activeChip;

  const raw = dt.getData(EDITOR_CHIP_MIME);
  if (raw) {
    const parsed = safeJsonParse<EditorChipPayload | null>(raw, null);
    if (parsed && typeof parsed.text === 'string') return parsed;
  }

  const text = dt.getData('text/plain');
  if (text && text.startsWith(TEXT_PREFIX)) {
    const parsed = safeJsonParse<EditorChipPayload | null>(text.slice(TEXT_PREFIX.length), null);
    if (parsed && typeof parsed.text === 'string') return parsed;
  }

  return null;
}

export function hasEditorChipDragData(dt: DataTransfer): boolean {
  if (_activeChip) return true;
  if (dt.types.includes(EDITOR_CHIP_MIME)) return true;
  if (dt.types.includes('text/plain')) {
    try {
      return dt.getData('text/plain').startsWith(TEXT_PREFIX);
    } catch {
      return false;
    }
  }
  return false;
}

/** Wire to `onDragEnd` on every chip drag source so the in-memory fallback
 *  never leaks past its own gesture. */
export const clearActiveEditorChipDrag = (): void => {
  _activeChip = null;
};

/**
 * Wrap a raw id/name as a single-quoted JS string literal, escaping embedded
 * backslashes/quotes — matches the single-quote convention the scaffolds
 * already emit (HookBuilderPanel/scaffold.ts's `formatOnLiteral`,
 * ToolBuilderPanel/scaffold.ts's `scaffoldToolTs`).
 */
export function quoteStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export interface StartEditorChipDragOptions {
  text: string;
  label?: string;
}

/**
 * Drag-start wiring for a chip pill. `stopPropagation` is extra safety (the
 * pane already ignores this MIME), matching `setChipDragPayload` in
 * utils/nodeChip/chipDragSource.ts.
 */
export function startEditorChipDrag(
  e: ReactDragEvent<HTMLElement>,
  { text, label }: StartEditorChipDragOptions
): void {
  e.stopPropagation();
  writeEditorChipDragData(e.dataTransfer, { text, label });
  e.dataTransfer.effectAllowed = 'copy';
}
