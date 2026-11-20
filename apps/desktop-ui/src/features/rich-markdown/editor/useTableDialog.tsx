import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Editor } from '@tiptap/react';

import { TableDialog } from '@desktop/features/rich-markdown/renderer/TableDialog';
import { TABLE_EXPAND_EVENT, type TableExpandDetail } from './deletableTable';
import { blockToRichMarkdown } from './richMarkdown';

interface OpenTable {
  markdown: string;
  /** The editor had focus at the press, so it gets it back on close. */
  refocus: boolean;
}

/**
 * The large view of a rich editor's table: listens on `hostRef` for a
 * table's Expand (`TABLE_EXPAND_EVENT`) and returns the dialog to render.
 * The dialog shows the table as it was at the press, written to markdown
 * with the editor's own serializer; nothing in it touches the document.
 * Closing gives the editor its focus back with the caret where it was.
 */
export function useTableDialog(
  editor: Editor | null,
  hostRef: RefObject<HTMLElement | null>
): ReactNode {
  const [open, setOpen] = useState<OpenTable | null>(null);
  const editorRef = useRef(editor);
  useEffect(() => {
    editorRef.current = editor;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onExpand = (event: Event) => {
      const { table } = (event as CustomEvent<TableExpandDetail>).detail;
      const current = editorRef.current;
      setOpen({
        markdown: blockToRichMarkdown(table),
        refocus: !!current && !current.isDestroyed && current.isFocused,
      });
    };
    host.addEventListener(TABLE_EXPAND_EVENT, onExpand);
    return () => host.removeEventListener(TABLE_EXPAND_EVENT, onExpand);
  }, [hostRef]);

  const refocus = open?.refocus ?? false;
  const close = useCallback(() => {
    const current = editorRef.current;
    // ProseMirror's own focus writes its kept selection back to the DOM,
    // before the dialog hands focus back to the element it took it from.
    if (refocus && current && !current.isDestroyed) current.view.focus();
    setOpen(null);
  }, [refocus]);

  return open ? <TableDialog markdown={open.markdown} onClose={close} /> : null;
}
