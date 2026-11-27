// Right-click format menu for the rich editor: open the web link under the
// pointer, turn the blocks under the selection into another block type,
// format the selected text, or cut, copy and paste. The app's context menus replace the webview's own, so the
// clipboard actions live here too.

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { Editor } from '@tiptap/react';

import { ContextMenu, type ContextMenuProps } from '@desktop/components/ContextMenu';
import { launchExternalUrl } from '@desktop/utils/externalLinks';
import { shortcutLabel } from '@desktop/utils/platform';
import { EditorPopover, EditorPopoverHeader, type EditorPopoverAnchor } from './EditorPopover';
import { BLOCK_FORMATS, INLINE_FORMATS, type FormatMenuItem } from './formatMenuItems';
import { externalLinkAt } from './linkOpen';
import styles from './FormatContextMenu.module.scss';

type MenuItems = ContextMenuProps['items'];

/** Runs a clipboard command on the editor's own selection. */
function clipboardCommand(editor: Editor, command: 'cut' | 'copy'): void {
  editor.view.focus();
  // ProseMirror's copy and cut handlers fill the clipboard (text and HTML).
  document.execCommand?.(command);
}

async function pasteFromClipboard(editor: Editor): Promise<void> {
  let text: string;
  try {
    text = (await navigator.clipboard?.readText()) ?? '';
  } catch {
    return;
  }
  if (!text || editor.isDestroyed) return;
  editor.view.focus();
  // Same path as a keyboard paste: markdown text turns into blocks.
  editor.view.pasteText(text);
}

/** Links the selection (or inserts the address as linked text), edits the
 *  address of the link under the caret, or removes it when `href` is empty. */
function applyLink(editor: Editor, href: string): void {
  if (!href) {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }
  if (editor.state.selection.empty && !editor.isActive('link')) {
    editor
      .chain()
      .focus()
      .insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] })
      .run();
    return;
  }
  editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
}

function LinkPrompt({
  editor,
  anchor,
  onClose,
}: {
  editor: Editor;
  anchor: EditorPopoverAnchor;
  onClose: () => void;
}) {
  const current = (editor.getAttributes('link').href as string | undefined) ?? '';
  const [href, setHref] = useState(current);
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => inputRef.current?.focus({ preventScroll: true }), []);

  const cancel = () => {
    onClose();
    editor.commands.focus();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onClose();
    applyLink(editor, href.trim());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };

  return (
    <EditorPopover anchor={anchor} ariaLabel="Link" role="dialog" width={320}>
      <EditorPopoverHeader glyph="↗" text={current ? 'Edit link' : 'Add link'} />
      <form className={styles.form} onSubmit={submit}>
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          aria-label="Link address"
          placeholder="https://"
          value={href}
          spellCheck={false}
          onChange={(event) => setHref(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onClose}
        />
        <p className={styles.hint}>Enter to save. Leave empty to remove the link.</p>
      </form>
    </EditorPopover>
  );
}

/**
 * The format menu for a rich editor: hand `onContextMenu` to the element
 * around the editor and render `element`.
 */
export function useFormatContextMenu(
  editor: Editor | null,
  disabled: boolean
): { onContextMenu: (event: MouseEvent) => void; element: ReactNode } {
  const [menuAt, setMenuAt] = useState<{
    x: number;
    y: number;
    /** The web link that was right-clicked, if any. */
    linkUrl: string | null;
  } | null>(null);
  const [linkAnchor, setLinkAnchor] = useState<EditorPopoverAnchor>(null);

  const onContextMenu = useCallback(
    (event: MouseEvent) => {
      if (disabled || !editor || editor.isDestroyed || !editor.isEditable) return;
      if (!(event.target instanceof Node) || !editor.view.dom.contains(event.target)) return;
      event.preventDefault();
      setLinkAnchor(null);
      setMenuAt({
        x: event.clientX,
        y: event.clientY,
        linkUrl: externalLinkAt(editor.view, event.target),
      });
    },
    [disabled, editor]
  );

  const openLinkPrompt = useCallback(() => {
    if (!editor) return;
    const { from } = editor.state.selection;
    let anchor: EditorPopoverAnchor;
    try {
      const coords = editor.view.coordsAtPos(from);
      anchor = { left: coords.left, top: coords.top, bottom: coords.bottom };
    } catch {
      const box = editor.view.dom.getBoundingClientRect();
      anchor = { left: box.left, top: box.top, bottom: box.top };
    }
    setLinkAnchor(anchor);
  }, [editor]);

  let element: ReactNode = null;
  if (editor && menuAt) {
    const toItem = (format: FormatMenuItem, separatorBefore = false): MenuItems[number] => ({
      label: format.label,
      checked: format.isActive(editor),
      shortcut: format.keys ? shortcutLabel(format.keys) : undefined,
      separatorBefore,
      onSelect: () => format.run(editor),
    });
    const empty = editor.state.selection.empty;
    const { linkUrl } = menuAt;
    const items: MenuItems = [
      ...(linkUrl ? [{ label: 'Open link', onSelect: () => launchExternalUrl(linkUrl) }] : []),
      ...BLOCK_FORMATS.map((format, i) => toItem(format, i === 0 && linkUrl !== null)),
      ...INLINE_FORMATS.map((format, i) => toItem(format, i === 0)),
      { label: 'Link…', checked: editor.isActive('link'), onSelect: openLinkPrompt },
      {
        label: 'Cut',
        shortcut: shortcutLabel(['Mod', 'X']),
        disabled: empty,
        separatorBefore: true,
        onSelect: () => clipboardCommand(editor, 'cut'),
      },
      {
        label: 'Copy',
        shortcut: shortcutLabel(['Mod', 'C']),
        disabled: empty,
        onSelect: () => clipboardCommand(editor, 'copy'),
      },
      {
        label: 'Paste',
        shortcut: shortcutLabel(['Mod', 'V']),
        onSelect: () => void pasteFromClipboard(editor),
      },
    ];
    element = (
      <ContextMenu
        ariaLabel="Format"
        x={menuAt.x}
        y={menuAt.y}
        items={items}
        onClose={() => setMenuAt(null)}
      />
    );
  } else if (editor && linkAnchor) {
    element = (
      <LinkPrompt editor={editor} anchor={linkAnchor} onClose={() => setLinkAnchor(null)} />
    );
  }

  return { onContextMenu, element };
}
