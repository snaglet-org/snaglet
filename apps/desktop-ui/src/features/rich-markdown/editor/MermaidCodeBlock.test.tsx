import { useEffect, useRef, type FC } from 'react';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

// The diagram renderer (mermaid library, debounce, image lifecycle) has its
// own tests; here it is a probe that exposes the source the node view hands it,
// with a node chip standing in for the chips laid over a chart.
const chipClick = vi.hoisted(() => vi.fn());
vi.mock('@desktop/features/rich-markdown/renderer/MermaidDiagram', () => ({
  MermaidDiagram: ({ source }: { source: string }) => (
    <div data-testid="mermaid-diagram" data-source={source}>
      <a
        className="md-chip"
        href="doc-1111111111111-aaaaaaaaa"
        onClick={(event) => {
          event.preventDefault();
          chipClick();
        }}
      >
        Spec
      </a>
    </div>
  ),
}));

import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { buildChipEditableExtensions, createSubmitExtension } from './chipEditableInput.extensions';
import { createChipEditorProps } from './chipEditableInput.editorProps';
import { docToRichMarkdown, richMarkdownToDoc } from './richMarkdown';

/**
 * Mermaid preview in the rich editor's `codeBlock` NodeView. The rich editor
 * bypasses MarkdownRenderer, so these tests mount the same extension set as
 * ChipEditableInput and check that a Mermaid fence shows a diagram and keeps
 * editable code, other fences stay plain, edits update the preview, and
 * mounting never rewrites the markdown.
 */

// jsdom has no layout engine; TipTap's placeholder extension calls
// elementFromPoint via posAtCoords while creating the view.
beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
});

function richExtensions() {
  const ref = <T,>(value: T) => ({ current: value });
  return buildChipEditableExtensions({
    submitExtension: createSubmitExtension({
      onSubmitRef: ref<(() => void) | undefined>(undefined),
      multilineRef: ref(true),
      submitOnEnterRef: ref(false),
      richBlocksRef: ref(true),
      mentionStateRef: ref(null),
      slashStateRef: ref(null),
    }),
    richBlocks: true,
    dropcursorConfig: { width: 2, color: false, class: 'snaglet-dropcursor' },
    multiline: true,
    allowInlineParse: true,
  });
}

/** Mount an editor with the rich extension set and load `markdown` the way
 *  ChipEditableInput does (richMarkdownToDoc → setContent, no emitUpdate). */
function mountEditor(markdown: string): Promise<Editor> {
  return new Promise((resolve) => {
    const Harness: FC = () => {
      const editor = useEditor({
        extensions: richExtensions(),
        content: '',
        editorProps: createChipEditorProps({
          richBlocks: true,
          multiline: true,
          slashStateRef: { current: null },
          mentionStateRef: { current: null },
          slashMenuRef: { current: null },
          mentionSearchRef: { current: null },
          setMentionState: () => {},
          setSlashState: () => {},
        }),
      });
      const loaded = useRef(false);
      useEffect(() => {
        if (!editor || loaded.current) return;
        loaded.current = true;
        editor.commands.setContent(
          richMarkdownToDoc(markdown, editor.schema, { parseBareIds: true }),
          {
            emitUpdate: false,
          }
        );
        resolve(editor);
      }, [editor]);
      return <EditorContent editor={editor} />;
    };
    render(<Harness />);
  });
}

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;
const FLOW = 'graph TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]';
const diagrams = () => screen.queryAllByTestId('mermaid-diagram');

describe('MermaidCodeBlock — rich editor preview', () => {
  it('lets normal external image and code drops continue to the editor parser', async () => {
    const editor = await mountEditor(fence('mermaid', FLOW));
    const handler = editor.view.props.handleDOMEvents?.drop;
    expect(handler).toBeDefined();
    for (const payload of [
      'flowchart TD\n  A --> B',
      '<img src="https://example.com/photo.png">',
    ]) {
      const event = new Event('drop', { cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { getData: (type: string) => (type === 'text/html' ? payload : '') },
      });
      expect(handler?.(editor.view, event as DragEvent)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it.each(['text/plain', 'text/uri-list', 'text/html'])(
    'rejects generated preview %s drops before serializing them into the source',
    async (type) => {
      const markdown = fence('mermaid', FLOW);
      const editor = await mountEditor(markdown);
      const source = document.querySelector('code.language-mermaid')!;
      const uri =
        'data:image/svg+xml;charset=utf-8,' +
        encodeURIComponent('<svg id="snaglet-mermaid-42">' + 'x'.repeat(60_000) + '</svg>');
      const payload = type === 'text/html' ? `<img src="${uri}">` : uri;
      const getData = (requested: string) => (requested === type ? payload : '');
      act(() => {
        expect(fireEvent.drop(source, { dataTransfer: { getData, types: [type] } })).toBe(false);
      });
      expect(docToRichMarkdown(editor, {})).toBe(markdown);
    }
  );

  it('renders a diagram for a ```mermaid fence and keeps the editable code block', async () => {
    await mountEditor(fence('mermaid', FLOW));

    await waitFor(() => expect(diagrams()).toHaveLength(1));
    expect(diagrams()[0]).toHaveAttribute('data-source', FLOW);

    const code = document.querySelector('pre > code.language-mermaid');
    expect(code).not.toBeNull();
    expect(code!.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('Edit diagram source')).toBeInTheDocument();
    expect(code).toHaveTextContent('A[Start] --> B{Ok?}');
    // Source is inside the editable surface; the preview is not.
    expect(code!.closest('[contenteditable="true"]')).not.toBeNull();
    const preview = diagrams()[0].closest('[data-mermaid-preview]');
    expect(preview).toHaveAttribute('contenteditable', 'false');
  });

  it('keeps ProseMirror out of presses on the diagram, so panning never selects or drags the block', async () => {
    const editor = await mountEditor(`${fence('mermaid', FLOW)}\n\nAfter.`);
    await waitFor(() => expect(diagrams()).toHaveLength(1));
    // A block that is already node-selected is what ProseMirror starts a
    // native node drag from; a press on its diagram must pan, not drag.
    act(() => {
      editor.commands.setNodeSelection(0);
    });
    const before = editor.state.selection.toJSON();
    // jsdom has no layout: report the press as landing inside the code block.
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 });
    const diagram = diagrams()[0];
    act(() => {
      fireEvent.mouseDown(diagram, { button: 0, detail: 1, clientX: 10, clientY: 10 });
    });
    expect(editor.view.dom.querySelector('[draggable="true"]')).toBeNull();
    act(() => {
      fireEvent.mouseUp(diagram, { button: 0, detail: 1, clientX: 10, clientY: 10 });
      fireEvent.mouseDown(diagram, { button: 0, detail: 2, clientX: 10, clientY: 10 });
      fireEvent.mouseUp(diagram, { button: 0, detail: 2, clientX: 10, clientY: 10 });
    });
    expect(editor.state.selection.toJSON()).toEqual(before);
  });

  it('lets a chip in the diagram take its click without moving the selection', async () => {
    const editor = await mountEditor(`${fence('mermaid', FLOW)}\n\nAfter.`);
    await waitFor(() => expect(diagrams()).toHaveLength(1));
    // The caret sits in the paragraph after the diagram; a press reported as
    // landing in the code block would move it there.
    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    const before = editor.state.selection.toJSON();
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 });
    chipClick.mockClear();
    const chip = within(diagrams()[0]).getByRole('link', { name: 'Spec' });
    act(() => {
      fireEvent.mouseDown(chip, { button: 0, detail: 1, clientX: 10, clientY: 10 });
      fireEvent.mouseUp(chip, { button: 0, detail: 1, clientX: 10, clientY: 10 });
      fireEvent.click(chip, { button: 0, detail: 1, clientX: 10, clientY: 10 });
    });
    expect(chipClick).toHaveBeenCalledOnce();
    expect(editor.state.selection.toJSON()).toEqual(before);
  });

  it('leaves other fences as plain code blocks', async () => {
    await mountEditor(fence('ts', 'const answer = 42;'));

    await waitFor(() => expect(document.querySelector('pre > code.language-ts')).not.toBeNull());
    expect(diagrams()).toHaveLength(0);
    expect(document.querySelector('[data-mermaid-preview]')).toBeNull();
  });

  it('auto-detects an unlabeled flowchart and ignores unlabeled prose', async () => {
    await mountEditor(`${fence('', 'flowchart LR\n  A --> B')}\n\n${fence('', 'just some text')}`);

    await waitFor(() => expect(diagrams()).toHaveLength(1));
    expect(diagrams()[0]).toHaveAttribute('data-source', 'flowchart LR\n  A --> B');
    expect(document.querySelectorAll('pre > code')).toHaveLength(2);
  });

  it('updates the preview as the source is edited, and the diagram disappears when it stops being one', async () => {
    const editor = await mountEditor(fence('mermaid', 'graph TD\n  A --> B'));
    await waitFor(() => expect(diagrams()).toHaveLength(1));

    // Append a line at the end of the block's text. A text node, not a
    // string: insertContent parses strings as HTML, which would turn a literal
    // `<br/>` in a Mermaid label into a break.
    act(() => {
      const end = editor.state.doc.firstChild!.nodeSize - 1;
      editor
        .chain()
        .setTextSelection(end)
        .insertContent({ type: 'text', text: '\n  B --> C' })
        .run();
    });
    await waitFor(() =>
      expect(diagrams()[0]).toHaveAttribute('data-source', 'graph TD\n  A --> B\n  B --> C')
    );

    // Relabel the block: an explicit non-mermaid language wins over content.
    act(() => {
      editor.chain().setTextSelection(2).updateAttributes('codeBlock', { language: 'txt' }).run();
    });
    await waitFor(() => expect(diagrams()).toHaveLength(0));
    expect(document.querySelector('pre > code.language-txt')).not.toBeNull();
  });

  it('keeps the codeBlock node name, so the submit keymap guard and commands still find it', async () => {
    const editor = await mountEditor(fence('mermaid', FLOW));
    await waitFor(() => expect(diagrams()).toHaveLength(1));

    act(() => editor.commands.setTextSelection(2));
    expect(editor.isActive('codeBlock')).toBe(true);
    expect(editor.getAttributes('codeBlock')).toMatchObject({ language: 'mermaid' });
    expect(editor.schema.nodes.codeBlock).toBeDefined();
  });
});

describe('MermaidCodeBlock — markdown stays byte-for-byte', () => {
  const cases: Array<[string, string]> = [
    ['explicit mermaid fence', fence('mermaid', FLOW)],
    [
      'labels with <br/> and quotes',
      fence('mermaid', 'graph LR\n  A["First line<br/>Second line"] --> B["it\'s \\"quoted\\""]'),
    ],
    ['unlabeled flowchart fence', fence('', 'graph TD\n  A --> B')],
    ['ordinary code fence', fence('ts', 'const x = "<br/>";')],
    ['fence between prose', `# Title\n\nBefore.\n\n${fence('mermaid', FLOW)}\n\nAfter.`],
    [
      'two diagrams',
      `${fence('mermaid', FLOW)}\n\n${fence('mermaid', 'sequenceDiagram\n  A->>B: hi')}`,
    ],
  ];

  it.each(cases)('%s: mounting then serializing does not rewrite the source', async (_name, md) => {
    const editor = await mountEditor(md);
    // Give the node views a tick to mount; they must not touch the doc.
    await waitFor(() => expect(document.querySelector('pre > code')).not.toBeNull());

    expect(docToRichMarkdown(editor)).toBe(md);
  });

  it('a diagram edited in the rich editor serializes back to a plain mermaid fence', async () => {
    const editor = await mountEditor(fence('mermaid', 'graph TD\n  A --> B'));
    await waitFor(() => expect(diagrams()).toHaveLength(1));

    act(() => {
      const end = editor.state.doc.firstChild!.nodeSize - 1;
      editor
        .chain()
        .setTextSelection(end)
        .insertContent({ type: 'text', text: '\n  B --> C["x<br/>y"]' })
        .run();
    });

    expect(docToRichMarkdown(editor)).toBe(
      fence('mermaid', 'graph TD\n  A --> B\n  B --> C["x<br/>y"]')
    );
  });
});

describe('raw flowchart files and clipboard input', () => {
  const source = 'flowchart TD\n    A["First\\nsecond"] --> B\n\n    B --> C\n';

  it('loads raw source as one diagram without losing whitespace or literal escapes', async () => {
    await mountEditor(source);
    await waitFor(() => expect(diagrams()).toHaveLength(1));
    expect(diagrams()[0]).toHaveAttribute('data-source', source);
  });

  it('pastes raw text as a closed code block between prose and supports undo', async () => {
    const editor = await mountEditor('Before');
    act(() => {
      editor.commands.setTextSelection(7);
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          getData: (type: string) => (type === 'text/plain' ? source : ''),
          files: [],
        },
      });
      editor.view.dom.dispatchEvent(event);
    });
    await waitFor(() => expect(diagrams()).toHaveLength(1));
    expect(diagrams()[0]).toHaveAttribute('data-source', source);
    expect(editor.state.doc.child(0).textContent).toBe('Before');
    expect(editor.state.doc.child(1).type.name).toBe('codeBlock');
    act(() => {
      editor.commands.undo();
    });
    expect(editor.state.doc.textContent).toBe('Before');
  });

  it('prefers exact clipboard text over accompanying HTML formatting', async () => {
    const editor = await mountEditor('');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) =>
          type === 'text/plain' ? source : '<p>flowchart TD flattened</p>',
        files: [],
      },
    });
    act(() => {
      editor.view.dom.dispatchEvent(event);
    });
    await waitFor(() => expect(diagrams()).toHaveLength(1));
    expect(diagrams()[0]).toHaveAttribute('data-source', source);
  });

  it('keeps paste inside an existing code block as text, without nesting diagrams', async () => {
    const editor = await mountEditor(fence('ts', 'prefix'));
    act(() => {
      editor.commands.setTextSelection(7);
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          getData: (type: string) => (type === 'text/plain' ? source : ''),
          files: [],
        },
      });
      editor.view.dom.dispatchEvent(event);
    });
    expect(editor.state.doc.child(1).textContent).toBe('');
    expect(editor.state.doc.firstChild!.textContent).toBe('prefix' + source);
    expect(diagrams()).toHaveLength(0);
  });
});
