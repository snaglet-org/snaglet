/**
 * An outline jump goes through the same heading-link focus as an in-doc chip,
 * but lands the heading near the top of the doc and flashes it briefly,
 * without moving the caret or focus. Rendered and markdown views alike.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { installEditorDomShims } from '../editor/richEditor.testHarness';
import { WorkspaceEditor } from '../workspace-editor/WorkspaceEditor';
import { outlineEntries } from '../outline/docOutline';
import { JUMP_MARGIN } from './jump';

beforeAll(installEditorDomShims);

const DOC_ID = 'doc-1111111111111-aaaaaaaaa';

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
].join('\n');

const rect = (top: number) =>
  ({ top, bottom: top + 20, height: 20, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;

/** jsdom has no element scrolling; record every `scrollTo` with its element. */
const scrollTo = vi.fn();

beforeEach(() => {
  scrollTo.mockReset();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: function (this: HTMLElement, options: ScrollToOptions) {
      scrollTo(this, options);
    },
  });
});

afterEach(() => {
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  vi.restoreAllMocks();
});

function mount(sourceMode: boolean) {
  const onFocusApplied = vi.fn();
  // The second "Beta": a repeated name still jumps to its own heading.
  const target = outlineEntries(MD)[2]!;
  render(
    <div data-testid="scroller" style={{ overflowY: 'auto' }}>
      <WorkspaceEditor
        kind="doc-body"
        savedValue={MD}
        onSave={vi.fn()}
        sourceMode={sourceMode}
        lineLinks={{
          docId: DOC_ID,
          docTitle: 'Plan',
          focus: { anchor: { heading: target.ref }, nonce: -2, jump: true },
          onFocusApplied,
        }}
      />
    </div>
  );
  return onFocusApplied;
}

describe('outline jump in the rendered editor', () => {
  it('scrolls the heading near the top of the doc and flashes it briefly', async () => {
    const secondBeta = () => document.querySelectorAll('.ProseMirror h2')[1];
    // The scroller sits 100px down the window and holds more than it shows;
    // the second Beta is 700px down.
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
      return this.getAttribute('data-testid') === 'scroller' ? 2000 : 0;
    });
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
      return this.getAttribute('data-testid') === 'scroller' ? 400 : 0;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.getAttribute('data-testid') === 'scroller') return rect(100);
      return rect(this === secondBeta() ? 700 : 0);
    });

    const onFocusApplied = mount(false);
    await waitFor(() => expect(onFocusApplied).toHaveBeenCalledWith(-2));

    const headings = Array.from(document.querySelectorAll<HTMLElement>('.ProseMirror h2'));
    expect(headings.map((h) => h.textContent)).toEqual(['Beta', 'Beta']);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(screen.getByTestId('scroller'), {
      top: 700 - 100 - JUMP_MARGIN,
      behavior: 'smooth',
    });
    expect(headings[1]).toHaveAttribute('data-line-flash');
    expect(headings[0]).not.toHaveAttribute('data-line-flash');

    // Brief: the flash clears itself. Focus stays where it was.
    await waitFor(() => expect(headings[1]).not.toHaveAttribute('data-line-flash'), {
      timeout: 3000,
    });
    expect(screen.getByRole('textbox', { name: 'Doc body' })).not.toHaveFocus();
  });

  it('lands the heading at the top of a zoomed pane too', async () => {
    // A narrow pane renders at zoom 0.5: rects come in viewport px, the
    // scroll position in the scroller's own px (twice as many).
    const secondBeta = () => document.querySelectorAll('.ProseMirror h2')[1];
    const isScroller = (el: Element) => el.getAttribute('data-testid') === 'scroller';
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
      return isScroller(this) ? 4000 : 0;
    });
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
      return isScroller(this) ? 800 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return isScroller(this) ? 1000 : 0;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (isScroller(this)) return { ...rect(100), width: 500 } as DOMRect;
      return rect(this === secondBeta() ? 700 : 0);
    });

    const onFocusApplied = mount(false);
    await waitFor(() => expect(onFocusApplied).toHaveBeenCalledWith(-2));

    expect(scrollTo).toHaveBeenCalledWith(screen.getByTestId('scroller'), {
      top: (700 - 100) / 0.5 - JUMP_MARGIN,
      behavior: 'smooth',
    });
  });
});

describe('outline jump in the markdown view', () => {
  it('scrolls the heading line near the top and flashes it, leaving the caret alone', async () => {
    // 20px lines on the styled backdrop.
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      const line = this.parentElement?.getAttribute('data-source-line');
      return line ? Number(line) * 20 : 0;
    });

    const onFocusApplied = mount(true);
    await waitFor(() => expect(onFocusApplied).toHaveBeenCalledWith(-2));

    const area = screen.getByTestId<HTMLTextAreaElement>('workspace-editor-source-textarea');
    // Line 9 (index 8) starts 160px down the text.
    expect(scrollTo).toHaveBeenCalledWith(area, { top: 160 - JUMP_MARGIN, behavior: 'smooth' });
    const line = document.querySelector('[data-source-line="8"] > span');
    expect(line).toHaveAttribute('data-line-flash');
    expect(area).not.toHaveFocus();
    expect(area.selectionStart).toBe(area.selectionEnd);

    await waitFor(() => expect(line).not.toHaveAttribute('data-line-flash'), { timeout: 3000 });
  });
});
