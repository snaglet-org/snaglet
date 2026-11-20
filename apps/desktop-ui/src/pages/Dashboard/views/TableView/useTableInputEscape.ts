import { useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/** Mention menus run first; unclaimed Escape must precede ProseMirror's native capture. */
export function useTableInputEscape(editor: Editor | null, onEscape?: () => void) {
  const callback = useRef(onEscape);
  callback.current = onEscape;
  const enabled = !!onEscape;

  useEffect(() => {
    if (!enabled || !editor || editor.isDestroyed) return;
    const key = new PluginKey('table-input-escape');
    editor.registerPlugin(
      new Plugin({
        key,
        props: {
          handleKeyDown: (_view, event) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return false;
            event.preventDefault();
            callback.current?.();
            return true;
          },
        },
      }),
      (plugin, plugins) => [plugin, ...plugins]
    );
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(key);
    };
  }, [editor, enabled]);
}
