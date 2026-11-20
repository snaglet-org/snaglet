/**
 * A chip dragged within an editor is ProseMirror's own move: the drop handler
 * that inserts chips dragged in from elsewhere must stand aside for it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EditorView } from '@tiptap/pm/view';
import type { Slice } from '@tiptap/pm/model';
import { NODE_CHIP_MIME } from '@desktop/utils/nodeChip';
import { createChipEditorProps } from './chipEditableInput.editorProps';

function props() {
  return createChipEditorProps({
    richBlocks: false,
    multiline: true,
    slashStateRef: { current: null },
    mentionStateRef: { current: null },
    slashMenuRef: { current: null },
    mentionSearchRef: { current: null },
    setMentionState: vi.fn(),
    setSlashState: vi.fn(),
  });
}

const chipTransfer = {
  types: [NODE_CHIP_MIME],
  getData: (type: string) =>
    type === NODE_CHIP_MIME
      ? JSON.stringify({ id: 'doc-1111111111111-aaaaaaaaa', kind: 'doc', title: 'Doc' })
      : '',
};

describe('chip editor drop handling', () => {
  it('leaves a drag that started in this editor to ProseMirror', () => {
    const dispatch = vi.fn();
    const view = {
      dom: document.createElement('div'),
      dragging: { slice: {} as Slice, move: true },
      dispatch,
    } as unknown as EditorView;
    const event = { dataTransfer: chipTransfer, preventDefault: vi.fn() } as unknown as DragEvent;
    const handled = props().handleDrop?.(view, event, {} as Slice, true);
    expect(handled).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
