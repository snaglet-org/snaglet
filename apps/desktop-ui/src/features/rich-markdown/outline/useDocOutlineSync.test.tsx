/**
 * The doc editor feeds the Properties panel's Outline: it publishes the doc's
 * own headings (at once, then after typing pauses) and which heading is in
 * view as the reader scrolls, in the rendered and the markdown view.
 */
import type { Editor } from '@tiptap/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) },
    docsApi: { ...actual.docsApi, get: api.get },
  };
});

import { installEditorDomShims } from '../editor/richEditor.testHarness';
import { WorkspaceEditor } from '../workspace-editor/WorkspaceEditor';
import { createDocOutlineStore, type DocOutlineStore } from './docOutline';

beforeAll(installEditorDomShims);

const DOC_ID = 'doc-1111111111111-aaaaaaaaa';
const OTHER = 'doc-2222222222222-bbbbbbbbb';

const MD = [
  '# Alpha', //      1
  '', //             2
  'Intro.', //       3
  '', //             4
  '## Beta', //      5
  '', //             6
  'Body.', //        7
  '', //             8
  '## Beta', //      9
  '', //             10
  'More.', //        11
  '', //             12
  '### Gamma', //    13
].join('\n');

function mount(store: DocOutlineStore, markdown: string, sourceMode: boolean) {
  return render(
    <WorkspaceEditor
      kind="doc-body"
      savedValue={markdown}
      onSave={vi.fn()}
      sourceMode={sourceMode}
      lineLinks={{ docId: DOC_ID, docTitle: 'Plan' }}
      outline={store}
    />
  );
}

const texts = (store: DocOutlineStore) => store.getState().entries.map((e) => e.text);

/** TipTap hangs the editor on its DOM node. */
function richEditor(): Editor {
  const dom = screen.getByRole('textbox', { name: 'Doc body' }) as HTMLElement & {
    editor?: Editor;
  };
  if (!dom.editor) throw new Error('no editor');
  return dom.editor;
}

function setTop(el: Element, top: number, height = 20) {
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;
}

function sourceLine(index: number): HTMLElement {
  const span = document.querySelector<HTMLElement>(`[data-source-line="${index}"] > span`);
  if (!span) throw new Error(`no source line ${index}`);
  return span;
}

beforeEach(() => {
  api.get.mockReset();
});

describe('outline headings from the editor', () => {
  it('publishes the headings at once, then follows edits after typing pauses', async () => {
    const store = createDocOutlineStore();
    mount(store, MD, true);
    expect(texts(store)).toEqual(['Alpha', 'Beta', 'Beta', 'Gamma']);
    expect(store.getState().entries.map((e) => e.level)).toEqual([1, 2, 2, 3]);

    const area = screen.getByTestId<HTMLTextAreaElement>('workspace-editor-source-textarea');
    fireEvent.change(area, { target: { value: `${MD}\n\n## Delta` } });
    // Debounced: the keystroke alone does not move the outline.
    expect(texts(store)).toEqual(['Alpha', 'Beta', 'Beta', 'Gamma']);
    await waitFor(() => expect(texts(store)).toEqual(['Alpha', 'Beta', 'Beta', 'Gamma', 'Delta']));
  });

  it('lists the headings of the rendered editor too', async () => {
    const store = createDocOutlineStore();
    mount(store, MD, false);
    expect(texts(store)).toEqual(['Alpha', 'Beta', 'Beta', 'Gamma']);
  });
});

describe('the heading in view (scroll-spy)', () => {
  it('follows the markdown view as it scrolls', async () => {
    const store = createDocOutlineStore();
    mount(store, MD, true);
    const area = screen.getByTestId<HTMLTextAreaElement>('workspace-editor-source-textarea');
    Object.defineProperty(area, 'clientHeight', { configurable: true, value: 200 });
    // 20px lines: Alpha 0, Beta 80, Beta 160, Gamma 240.
    for (const line of [0, 4, 8, 12]) {
      Object.defineProperty(sourceLine(line), 'offsetTop', {
        configurable: true,
        value: line * 20,
      });
    }

    area.scrollTop = 170;
    fireEvent.scroll(area);
    await waitFor(() => expect(store.getState().active).toBe(2));

    area.scrollTop = 0;
    fireEvent.scroll(area);
    await waitFor(() => expect(store.getState().active).toBe(0));
  });

  it("follows the rendered editor and ignores a transcluded doc's headings", async () => {
    api.get.mockResolvedValue({ id: OTHER, title: 'Other', content: '# Embedded\n\nIts text.' });
    const md = `${MD}\n\n![Other](${OTHER})\n\n## Omega`;
    const store = createDocOutlineStore();
    mount(store, md, false);
    expect(texts(store)).toEqual(['Alpha', 'Beta', 'Beta', 'Gamma', 'Omega']);

    const root = await screen.findByRole('textbox', { name: 'Doc body' });
    const embeddedHeading = () =>
      Array.from(root.querySelectorAll('h1')).find((h) => h.textContent === 'Embedded');
    await waitFor(() => expect(embeddedHeading()).toBeDefined());
    const embedded = embeddedHeading();

    setTop(richEditor().view.dom, 0, 600);
    const own = Array.from(
      richEditor().view.dom.querySelectorAll(':scope > h1, :scope > h2, :scope > h3')
    );
    expect(own.map((h) => h.textContent)).toEqual(['Alpha', 'Beta', 'Beta', 'Gamma', 'Omega']);
    [-500, -300, -100, -40, 400].forEach((top, i) => setTop(own[i]!, top));
    // Between Gamma and Omega, right at the reading line: it must not count.
    setTop(embedded!, 10);

    fireEvent.scroll(document);
    await waitFor(() => expect(store.getState().active).toBe(3));
  });

  it('keeps a jumped-to heading marked until the reader scrolls the doc', async () => {
    const store = createDocOutlineStore();
    mount(store, MD, true);
    const area = screen.getByTestId<HTMLTextAreaElement>('workspace-editor-source-textarea');
    Object.defineProperty(area, 'clientHeight', { configurable: true, value: 200 });
    for (const line of [0, 4, 8, 12]) {
      Object.defineProperty(sourceLine(line), 'offsetTop', {
        configurable: true,
        value: line * 20,
      });
    }

    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    store.hold(3);
    // The jump's own scroll keeps it.
    area.scrollTop = 170;
    fireEvent.scroll(area);
    await nextFrame();
    expect(store.getState().active).toBe(3);

    // A wheel that moves nothing (the doc is at its end) keeps it too.
    fireEvent.wheel(area);
    await nextFrame();
    expect(store.getState().active).toBe(3);
    expect(store.isHeld()).toBe(true);

    // A scroll the reader makes ends it.
    fireEvent.wheel(area);
    fireEvent.scroll(area);
    await waitFor(() => expect(store.getState().active).toBe(2));
    expect(store.isHeld()).toBe(false);
  });

  it('lets scrolling decide again after a switch between the markdown and rendered views', () => {
    const store = createDocOutlineStore();
    const props = {
      kind: 'doc-body' as const,
      savedValue: MD,
      onSave: vi.fn(),
      lineLinks: { docId: DOC_ID, docTitle: 'Plan' },
      outline: store,
    };
    const { rerender } = render(<WorkspaceEditor {...props} sourceMode />);
    store.hold(3);
    // The other view restores the caret's place, not the jump's.
    rerender(<WorkspaceEditor {...props} sourceMode={false} />);
    expect(store.isHeld()).toBe(false);
  });
});
