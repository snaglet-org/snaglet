import type { FC } from 'react';
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { isMermaidBlock } from '@desktop/features/rich-markdown/renderer/isMermaidBlock';
import { MermaidDiagram } from '@desktop/features/rich-markdown/renderer/MermaidDiagram';

/**
 * React NodeView for the rich editor's `codeBlock`. The block keeps
 * StarterKit's `<pre><code class="language-…">` shape and never writes to the
 * document. For a Mermaid block (`isMermaidBlock`) the source sits in a
 * disclosure and the diagram renders below it in a `contentEditable={false}`
 * region, so the caret can't enter it and ProseMirror ignores its DOM.
 */
export const CodeBlockNodeView: FC<NodeViewProps> = ({ node, extension }) => {
  const language = typeof node.attrs.language === 'string' ? node.attrs.language : null;
  const source = node.textContent;
  const options = extension.options as {
    languageClassPrefix?: string | null;
    HTMLAttributes?: Record<string, unknown>;
  };
  const prefix = options.languageClassPrefix ?? 'language-';
  const preview = isMermaidBlock(language, source);

  const code = (
    <pre {...(options.HTMLAttributes ?? {})}>
      <NodeViewContent<'code'>
        as="code"
        className={language ? `${prefix}${language}` : undefined}
      />
    </pre>
  );

  return (
    <NodeViewWrapper as="div" data-code-block="" data-language={language ?? undefined}>
      {preview ? (
        <details>
          <summary contentEditable={false}>Edit diagram source</summary>
          {code}
        </details>
      ) : (
        code
      )}
      {preview && (
        <div contentEditable={false} data-mermaid-preview="" aria-label="Diagram preview">
          <MermaidDiagram source={source} showSource={false} />
        </div>
      )}
    </NodeViewWrapper>
  );
};
