/**
 * resolveDropInsertText / isRecognizedEditorDrop — the payload-sniffing half
 * of HandlerEditor's drop handling. Pins the three
 * payload shapes in priority order (editor chip > NODE_CHIP_MIME >
 * PANE_ITEM_MIME), and that an unrecognized drag (e.g. a plain OS file drop)
 * is left alone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import {
  NODE_CHIP_LIST_MIME,
  NODE_CHIP_MIME,
  encodeChipDragList,
  setActiveDragChip,
} from '@desktop/utils/nodeChip/payload';
import { clearActiveEditorChipDrag, EDITOR_CHIP_MIME } from './editorChip';
import { isRecognizedEditorDrop, resolveDropInsertText } from './resolveDropInsertText';

function fakeDataTransfer(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get types() {
      return [...store.keys()];
    },
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
  } as unknown as DataTransfer;
}

afterEach(() => {
  clearActiveEditorChipDrag();
  setActiveDragChip(null);
});

describe('isRecognizedEditorDrop', () => {
  it('recognizes an editor chip drag', () => {
    expect(isRecognizedEditorDrop(fakeDataTransfer({ [EDITOR_CHIP_MIME]: '{}' }))).toBe(true);
  });

  it('recognizes a NODE_CHIP_MIME sidebar drag', () => {
    expect(isRecognizedEditorDrop(fakeDataTransfer({ [NODE_CHIP_MIME]: '{}' }))).toBe(true);
  });

  it('recognizes a PANE_ITEM_MIME sidebar drag', () => {
    expect(isRecognizedEditorDrop(fakeDataTransfer({ [PANE_ITEM_MIME]: '{}' }))).toBe(true);
  });

  it('does not recognize an unrelated drag (e.g. an OS file drop)', () => {
    expect(isRecognizedEditorDrop(fakeDataTransfer({ Files: '' }))).toBe(false);
  });
});

describe('resolveDropInsertText', () => {
  it('uses the editor chip payload verbatim when present', () => {
    const dt = fakeDataTransfer({
      [EDITOR_CHIP_MIME]: JSON.stringify({ text: "'message:create'" }),
    });
    expect(resolveDropInsertText(dt)).toBe("'message:create'");
  });

  it('quotes the id from a NODE_CHIP_MIME payload (tree rows / ToolsView)', () => {
    const dt = fakeDataTransfer({
      [NODE_CHIP_MIME]: JSON.stringify({ id: 'doc-42', kind: 'doc', title: 'Notes' }),
    });
    expect(resolveDropInsertText(dt)).toBe("'doc-42'");
  });

  it('inserts every row of a multi-row drag as quoted ids, comma-separated in order', () => {
    const dt = fakeDataTransfer({
      [NODE_CHIP_LIST_MIME]: encodeChipDragList({
        chips: [
          { id: 'doc-1111111111111-aaaaaaaaa', kind: 'doc', title: 'Doc A' },
          { id: 'thread-2222222222222-bbbbbbbbb', kind: 'thread', title: 'Thread B' },
          { id: 'doc-3333333333333-ccccccccc', kind: 'doc', title: 'Doc C' },
        ],
        unlinkable: 0,
      }),
      [NODE_CHIP_MIME]: JSON.stringify({ id: 'thread-2222222222222-bbbbbbbbb', kind: 'thread' }),
    });
    expect(resolveDropInsertText(dt)).toBe(
      "'doc-1111111111111-aaaaaaaaa', 'thread-2222222222222-bbbbbbbbb', 'doc-3333333333333-ccccccccc'"
    );
  });

  it('inserts the complete provider model id as a quoted code literal', () => {
    const dt = fakeDataTransfer({
      [NODE_CHIP_MIME]: JSON.stringify({
        id: 'anthropic/claude-sonnet-4:latest',
        kind: 'model',
        title: 'Claude Sonnet',
      }),
    });
    expect(resolveDropInsertText(dt)).toBe("'anthropic/claude-sonnet-4:latest'");
  });

  it('quotes the id from a PANE_ITEM_MIME agent selection (via the agent chip mapping)', () => {
    const dt = fakeDataTransfer({
      [PANE_ITEM_MIME]: JSON.stringify({ kind: 'agent', agent: { id: 'agent-7', name: 'Rosie' } }),
    });
    expect(resolveDropInsertText(dt)).toBe("'agent-7'");
  });

  it('quotes the id from a PANE_ITEM_MIME hook selection', () => {
    const dt = fakeDataTransfer({
      [PANE_ITEM_MIME]: JSON.stringify({ kind: 'hook', hook: { hookName: 'my-hook' } }),
    });
    expect(resolveDropInsertText(dt)).toBe("'my-hook'");
  });

  it('prefers the editor chip payload over a co-present NODE_CHIP_MIME', () => {
    const dt = fakeDataTransfer({
      [EDITOR_CHIP_MIME]: JSON.stringify({ text: "'from-chip'" }),
      [NODE_CHIP_MIME]: JSON.stringify({ id: 'doc-1', kind: 'doc' }),
    });
    expect(resolveDropInsertText(dt)).toBe("'from-chip'");
  });

  it('returns null when nothing recognizable is present', () => {
    expect(resolveDropInsertText(fakeDataTransfer())).toBeNull();
  });

  it('returns null for a malformed PANE_ITEM_MIME payload rather than throwing', () => {
    const dt = fakeDataTransfer({ [PANE_ITEM_MIME]: '{not json' });
    expect(resolveDropInsertText(dt)).toBeNull();
  });
});
