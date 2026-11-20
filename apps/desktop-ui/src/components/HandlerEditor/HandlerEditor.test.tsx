/**
 * HandlerEditor tests mount the real CodeMirror view and drive it through DOM
 * events (ToolBuilderPanel.test.tsx mocks it instead). jsdom's `Range` lacks
 * `getClientRects`/`getBoundingClientRect`, which CodeMirror's layout pass
 * needs; the polyfill below is scoped to this file.
 *
 * Assertions stay at the wrapper's contract (content in, onChange out,
 * readOnly locks editing), not CodeMirror internals.
 */
import { createRef } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import { NODE_CHIP_MIME } from '@desktop/utils/nodeChip/payload';
import { HandlerEditor, type HandlerEditorHandle } from './HandlerEditor';
import { EDITOR_CHIP_MIME } from './editorChip';
import { paletteSearchApi } from '@desktop/utils/api/palette-search';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeAll(() => {
  if (!Range.prototype.getClientRects) {
    // @ts-expect-error — jsdom gap polyfill, see file header comment.
    Range.prototype.getClientRects = () => [];
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    });
  }
});

function getContentEditable(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.cm-content');
  if (!el) throw new Error('CodeMirror content root not found');
  return el as HTMLElement;
}

function getEditorRoot(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-testid="handler-editor"]');
  if (!el) throw new Error('HandlerEditor root not found');
  return el as HTMLElement;
}

/** Minimal DataTransfer stand-in — jsdom has no native DataTransfer; same
 *  pattern ArchiveDropZone.test.tsx and ChipPalette.test.tsx use. */
function fakeDataTransfer(entries: Record<string, string>) {
  const store = new Map(Object.entries(entries));
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() {
      return [...store.keys()];
    },
    dropEffect: 'none',
  };
}

describe('HandlerEditor', () => {
  it('renders the initial value', () => {
    const { container } = render(
      <HandlerEditor value={'export default async function handler() {}\n'} onChange={vi.fn()} />
    );
    expect(container.textContent).toContain('export default async function handler');
  });

  it('reports edits via onChange with the full updated document', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<HandlerEditor value="const x = 1;" onChange={onChange} />);
    const editable = getContentEditable(container);

    await user.click(editable);
    await user.keyboard('{Home}// ');

    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1] as [string];
    expect(lastCall[0]).toBe('// const x = 1;');
  });

  it('syncs external value changes (e.g. a fetch resolving after mount)', () => {
    const { container, rerender } = render(<HandlerEditor value="first" onChange={vi.fn()} />);
    expect(container.textContent).toContain('first');

    rerender(<HandlerEditor value="second, loaded later" onChange={vi.fn()} />);
    expect(container.textContent).toContain('second, loaded later');
    expect(container.textContent).not.toContain('first');
  });

  it('does not fight the user by re-dispatching identical external values', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const Wrapper = () => {
      // A controlled parent that re-passes the same value prop reference
      // is a common source of feedback loops — assert typing still works.
      return <HandlerEditor value="abc" onChange={onChange} />;
    };
    const { container } = render(<Wrapper />);
    const editable = getContentEditable(container);
    await user.click(editable);
    await user.keyboard('{End}d');
    expect(onChange).toHaveBeenCalledWith('abcd');
  });

  it('blocks edits when readOnly, and unlocks when it flips back', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container, rerender } = render(
      <HandlerEditor value="locked" onChange={onChange} readOnly />
    );
    const editable = getContentEditable(container);
    expect(editable.getAttribute('contenteditable')).toBe('false');

    await user.click(editable);
    await user.keyboard('X');
    expect(onChange).not.toHaveBeenCalled();

    rerender(<HandlerEditor value="locked" onChange={onChange} readOnly={false} />);
    expect(getContentEditable(container).getAttribute('contenteditable')).toBe('true');
  });

  it('applies the aria-label to the editable root', () => {
    render(<HandlerEditor value="x" onChange={vi.fn()} aria-label="Custom label" />);
    expect(screen.getByLabelText('Custom label')).toBeInTheDocument();
  });
});

describe('HandlerEditor — hook mention search', () => {
  it('replaces an @trigger: query with the selected quoted runtime event', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <HandlerEditor
        value=""
        onChange={onChange}
        enableNodeMentions
        mentionTriggerOptions={[
          { value: 'agent:create', label: 'Agent created' },
          { value: 'agent:update', label: 'Agent updated' },
        ]}
        enableDropInsert={false}
      />
    );

    await user.click(getContentEditable(container));
    await user.keyboard('@trigger:update');
    await screen.findByRole('option', { name: /agent updated/i });
    expect(getEditorRoot(container)).toHaveAttribute('data-mention-open', 'true');
    expect(container.querySelector('.cm-tooltip-autocomplete')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1] as [string];
    expect(lastCall[0]).toBe("'agent:update'");
    expect(getEditorRoot(container)).not.toHaveAttribute('data-mention-open');
  });

  it('replaces a node query with the selected canonical quoted id', async () => {
    vi.spyOn(paletteSearchApi, 'search').mockResolvedValue({
      byKind: {},
      channelsUsed: ['fts'],
      semanticStatus: 'ready',
      coverage: {},
      items: [
        {
          type: 'workspace',
          nodeId: 'doc-42',
          nodeType: 'doc',
          title: 'Launch notes',
          subtitle: null,
          icon: null,
          score: 1,
          archived: false,
        },
      ],
      filesystem: [],
      files: [],
      meta: { query: 'launch', kinds: ['doc'], workspaceCount: 1, filesystemCount: 0 },
    });
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <HandlerEditor value="" onChange={onChange} enableNodeMentions enableDropInsert={false} />
    );

    await user.click(getContentEditable(container));
    await user.keyboard('@doc:launch');
    const option = await screen.findByRole('option', { name: /launch notes/i });
    fireEvent.mouseDown(option);

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1] as [string];
    expect(lastCall[0]).toBe("'doc-42'");
  });

  it('closes and dismisses an active mention when the code editor loses focus', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <HandlerEditor
          value=""
          onChange={vi.fn()}
          enableNodeMentions
          mentionTriggerOptions={[{ value: 'run:end', label: 'Agent run ended' }]}
          enableDropInsert={false}
        />
        <button type="button">Outside editor</button>
      </>
    );
    const editor = getContentEditable(container);

    await user.click(editor);
    await user.keyboard('@trigger:run');
    await screen.findByRole('option', { name: /agent run ended/i });
    await user.click(screen.getByRole('button', { name: 'Outside editor' }));

    await vi.waitFor(() => {
      expect(
        screen.queryByRole('listbox', { name: 'Mention suggestions' })
      ).not.toBeInTheDocument();
    });
    expect(getEditorRoot(container)).not.toHaveAttribute('data-mention-open');
  });
});

/**
 * Drag/drop, per the drop contract in HandlerEditor's component doc comment:
 * the editor claims a recognized drop before the pane's split-zone handler
 * (an ancestor in the real app) sees it, and inserts the resolved literal.
 */
describe('HandlerEditor — drag/drop', () => {
  it('can disable drop insertion for the hook editor without swallowing the pane drop', () => {
    const onChange = vi.fn();
    const outerOnDrop = vi.fn();
    const { container } = render(
      <div onDrop={outerOnDrop}>
        <HandlerEditor value="" onChange={onChange} enableDropInsert={false} />
      </div>
    );
    const root = getEditorRoot(container);

    fireEvent.drop(root, {
      dataTransfer: fakeDataTransfer({
        [EDITOR_CHIP_MIME]: JSON.stringify({ text: "'message:create'" }),
      }),
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(outerOnDrop).toHaveBeenCalledOnce();
    expect(root).not.toHaveAttribute('data-pane-drop-target');
  });

  it('dropping a sidebar node (PANE_ITEM_MIME, e.g. AgentsList/HooksView rows) inserts its quoted id', () => {
    const onChange = vi.fn();
    const { container } = render(<HandlerEditor value="const x = 1;" onChange={onChange} />);
    const root = getEditorRoot(container);

    fireEvent.drop(root, {
      dataTransfer: fakeDataTransfer({
        [PANE_ITEM_MIME]: JSON.stringify({
          kind: 'agent',
          agent: { id: 'agent-7', name: 'Rosie' },
        }),
      }),
      clientX: 0,
      clientY: 0,
    });

    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1] as [string];
    // jsdom's zeroed-out layout makes `posAtCoords` return null, so the
    // fallback is end-of-doc — see HandlerEditor.tsx's handleDrop.
    expect(lastCall[0]).toBe("const x = 1;'agent-7'");
  });

  it('dropping a NODE_CHIP_MIME payload (tree rows / ToolsView) inserts its quoted id', () => {
    const onChange = vi.fn();
    const { container } = render(<HandlerEditor value="" onChange={onChange} />);
    const root = getEditorRoot(container);

    fireEvent.drop(root, {
      dataTransfer: fakeDataTransfer({
        [NODE_CHIP_MIME]: JSON.stringify({ id: 'doc-42', kind: 'doc', title: 'Notes' }),
      }),
      clientX: 0,
      clientY: 0,
    });

    expect(onChange).toHaveBeenCalledWith("'doc-42'");
  });

  it('dropping an editor chip (EDITOR_CHIP_MIME — trigger/reference chips) inserts its literal verbatim', () => {
    const onChange = vi.fn();
    const { container } = render(<HandlerEditor value="" onChange={onChange} />);
    const root = getEditorRoot(container);

    fireEvent.drop(root, {
      dataTransfer: fakeDataTransfer({
        [EDITOR_CHIP_MIME]: JSON.stringify({ text: "'message:create'" }),
      }),
      clientX: 0,
      clientY: 0,
    });

    expect(onChange).toHaveBeenCalledWith("'message:create'");
  });

  it('claims a recognized drop and stops it from reaching an ancestor (the pane, in the real app)', () => {
    const onChange = vi.fn();
    const outerOnDrop = vi.fn();
    const { container } = render(
      <div onDrop={outerOnDrop}>
        <HandlerEditor value="" onChange={onChange} />
      </div>
    );
    const root = getEditorRoot(container);

    fireEvent.drop(root, {
      dataTransfer: fakeDataTransfer({
        [EDITOR_CHIP_MIME]: JSON.stringify({ text: "'x'" }),
      }),
      clientX: 0,
      clientY: 0,
    });

    expect(onChange).toHaveBeenCalledWith("'x'");
    expect(outerOnDrop).not.toHaveBeenCalled();
  });

  it('leaves an unrecognized drag alone (does not insert, does not stop propagation)', () => {
    const onChange = vi.fn();
    const outerOnDrop = vi.fn();
    const { container } = render(
      <div onDrop={outerOnDrop}>
        <HandlerEditor value="const x = 1;" onChange={onChange} />
      </div>
    );
    const root = getEditorRoot(container);

    fireEvent.drop(root, {
      dataTransfer: fakeDataTransfer({ Files: '' }),
      clientX: 0,
      clientY: 0,
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(outerOnDrop).toHaveBeenCalled();
  });

  it('a drop landing on the CodeMirror content DOM inserts the resolved id ONCE — not the raw __snaglet_chip__ text/plain blob (real-browser path)', () => {
    // Real drags land on `.cm-content`, where CodeMirror's own built-in drop
    // handler runs first (native bubbling) and inserts the drag's raw
    // text/plain — `__snaglet_chip__:{…}` for a sidebar chip — before the React
    // onDrop on the wrapper (delegated at the app root) fires and inserts
    // again. Mechanism (3) in HandlerEditor.tsx intercepts inside
    // CodeMirror's chain. This mirrors writeChipDragData's real payload,
    // including the `Text` alias CodeMirror's built-in handler reads.
    const onChange = vi.fn();
    const outerOnDrop = vi.fn();
    const { container } = render(
      <div onDrop={outerOnDrop}>
        <HandlerEditor value="" onChange={onChange} />
      </div>
    );
    const content = getContentEditable(container);

    const chipJson = JSON.stringify({ id: 'diff_files', kind: 'tool', title: 'Diff Files' });
    const dt = fakeDataTransfer({
      [NODE_CHIP_MIME]: chipJson,
      'text/plain': `__snaglet_chip__:${chipJson}`,
    });
    // Browsers alias 'Text' to 'text/plain' — CodeMirror's built-in drop
    // handler asks for 'Text', so the alias is what makes this test able to
    // catch a regression to the double-insert.
    const baseGetData = dt.getData;
    dt.getData = (type: string) => baseGetData(type === 'Text' ? 'text/plain' : type);

    fireEvent.drop(content, { dataTransfer: dt, clientX: 0, clientY: 0 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("'diff_files'");
    expect(outerOnDrop).not.toHaveBeenCalled();
  });

  it("exposes insertText via ref for the chip palettes' click-to-insert path", () => {
    const onChange = vi.fn();
    const ref = createRef<HandlerEditorHandle>();
    render(<HandlerEditor ref={ref} value="const x = 1;" onChange={onChange} />);

    ref.current?.insertText("'agent-1'");

    // Fresh CodeMirror docs start with the cursor at position 0.
    expect(onChange).toHaveBeenCalledWith("'agent-1'const x = 1;");
  });
});
