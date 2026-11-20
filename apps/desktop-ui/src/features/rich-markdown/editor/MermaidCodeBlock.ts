import { CodeBlock } from '@tiptap/extension-code-block';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { CodeBlockNodeView } from './CodeBlockNodeView';

/**
 * A press on a diagram preview belongs to its pan/zoom viewer. ProseMirror
 * would otherwise treat it as a click on the code block: select the block,
 * and once the block is node-selected start a native node drag that steals
 * the pointer from a pan.
 */
const diagramPressPlugin = new Plugin({
  key: new PluginKey('mermaidDiagramPress'),
  props: {
    handleDOMEvents: {
      mousedown: (_view, event) =>
        event.target instanceof Element && event.target.closest('[data-mermaid-preview]') !== null,
    },
  },
});

/**
 * StarterKit's CodeBlock with a React NodeView (see CodeBlockNodeView).
 * `extend` keeps the node name `codeBlock`, so the markdown round-trip,
 * keymaps, input rules and paste handling keyed on it still apply. Install it
 * with StarterKit's `codeBlock: false` so the node isn't registered twice.
 */
export const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView);
  },
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), diagramPressPlugin];
  },
});
