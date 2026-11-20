/**
 * editorChip, the chip-palette drag payload. Pins:
 *  - round-trip through the canonical MIME.
 *  - the in-memory Tauri/WKWebView fallback.
 *  - `quoteStringLiteral`'s escaping.
 *  - this MIME is not `PANE_ITEM_MIME`, which is what makes usePaneDropZone
 *    ignore a chip drag (usePaneDropZone.test.ts covers the behavior).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import {
  clearActiveEditorChipDrag,
  EDITOR_CHIP_MIME,
  hasEditorChipDragData,
  quoteStringLiteral,
  readEditorChipDragData,
  writeEditorChipDragData,
} from './editorChip';

function fakeDataTransfer(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get types() {
      return [...store.keys()];
    },
    setData: (type: string, value: string) => {
      store.set(type, value);
    },
    getData: (type: string) => store.get(type) ?? '',
  } as unknown as DataTransfer;
}

afterEach(() => {
  clearActiveEditorChipDrag();
});

describe('quoteStringLiteral', () => {
  it('wraps a plain value in single quotes', () => {
    expect(quoteStringLiteral('tool-abc123')).toBe("'tool-abc123'");
  });

  it('escapes embedded single quotes and backslashes', () => {
    expect(quoteStringLiteral("o'brien")).toBe("'o\\'brien'");
    expect(quoteStringLiteral('a\\b')).toBe("'a\\\\b'");
  });
});

describe('writeEditorChipDragData / readEditorChipDragData', () => {
  it('round-trips through EDITOR_CHIP_MIME', () => {
    const dt = fakeDataTransfer();
    writeEditorChipDragData(dt, { text: "'message:create'", label: 'Message created' });
    clearActiveEditorChipDrag(); // force the reader off the in-memory fallback
    const read = readEditorChipDragData(dt);
    expect(read).toEqual({ text: "'message:create'", label: 'Message created' });
  });

  it('never writes PANE_ITEM_MIME — chips must stay invisible to the pane drop zone', () => {
    const dt = fakeDataTransfer();
    writeEditorChipDragData(dt, { text: "'tool-1'" });
    expect(dt.types).not.toContain(PANE_ITEM_MIME);
  });

  it('falls back to the in-memory store when custom MIME reads are unavailable (WKWebView)', () => {
    const dt = fakeDataTransfer();
    writeEditorChipDragData(dt, { text: "'thread-9'" });
    // Simulate WKWebView eating setData for the custom MIME and text/plain —
    // types is empty, but the in-memory store still has it.
    const strippedDt = { types: [] as string[], getData: () => '' } as unknown as DataTransfer;
    expect(readEditorChipDragData(strippedDt)).toEqual({ text: "'thread-9'" });
  });

  it('falls back to the text/plain-prefixed payload when the custom MIME is absent', () => {
    const dt = fakeDataTransfer();
    writeEditorChipDragData(dt, { text: "'agent-1'" });
    clearActiveEditorChipDrag();
    const textOnlyDt = fakeDataTransfer({ 'text/plain': dt.getData('text/plain') });
    expect(readEditorChipDragData(textOnlyDt)).toEqual({ text: "'agent-1'" });
  });

  it('returns null for a drag with no recognizable chip payload', () => {
    clearActiveEditorChipDrag();
    expect(readEditorChipDragData(fakeDataTransfer())).toBeNull();
  });
});

describe('hasEditorChipDragData', () => {
  it('is true once the MIME type is present', () => {
    const dt = fakeDataTransfer({ [EDITOR_CHIP_MIME]: '{}' });
    expect(hasEditorChipDragData(dt)).toBe(true);
  });

  it('is false for an unrelated drag (e.g. a sidebar node carrying only PANE_ITEM_MIME)', () => {
    clearActiveEditorChipDrag();
    const dt = fakeDataTransfer({ [PANE_ITEM_MIME]: '{"kind":"tool"}' });
    expect(hasEditorChipDragData(dt)).toBe(false);
  });
});
