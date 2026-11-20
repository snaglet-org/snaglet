/**
 * Links to a heading of the doc they sit in (`[Beta](#h=beta)`, GitHub's
 * `[Beta](#beta)`, or `[Beta](doc-<this doc>#h=beta)` in the markdown view)
 * scroll there in place, the way an outline jump does: the heading lands near
 * the top and flashes. A click in the rendered view follows one; the markdown
 * view stays plain text, so there it takes ⌘-click (Ctrl-click in jsdom). A
 * link to a heading that is not there moves nothing and navigates nowhere.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) },
    tablesApi: { ...actual.tablesApi, list: vi.fn(async () => ({ tables: [] })) },
  };
});

import { TOAST_EVENT_NAME } from '@desktop/utils/toast';
import { installEditorDomShims } from '../editor/richEditor.testHarness';
import { WorkspaceEditor } from '../workspace-editor/WorkspaceEditor';
import { useDocLineFocusRequest } from './lineFocusStore';
import { JUMP_MARGIN } from './jump';

beforeAll(installEditorDomShims);

const DOC_ID = 'doc-1111111111111-aaaaaaaaa';
const OTHER_DOC = 'doc-2222222222222-bbbbbbbbb';

const INDEX = '[First](#h=beta) · [Second](#h=beta-1) · [GitHub](#beta-1) · [Gone](#q1)';
const MD = [
  '# Alpha', //                                       1
  '', //                                              2
  INDEX, //                                           3
  '', //                                              4
  `[Self](${DOC_ID}#h=beta-1) [Other](${OTHER_DOC}#h=beta)`, // 5
  '', //                                              6
  '## Beta', //                                       7
  '', //                                              8
  'Body.', //                                         9
  '', //                                              10
  '## Beta', //                                       11
  '', //                                              12
  'More.', //                                         13
].join('\n');

const rect = (top: number) =>
  ({ top, bottom: top + 20, height: 20, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;

/** jsdom has no element scrolling; record every `scrollTo` with its element. */
const scrollTo = vi.fn();
const toasts = vi.fn();
const onToast = (event: Event) =>
  toasts((event as CustomEvent<{ message: string }>).detail.message);

beforeEach(() => {
  scrollTo.mockReset();
  toasts.mockReset();
  window.addEventListener(TOAST_EVENT_NAME, onToast);
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: function (this: HTMLElement, options: ScrollToOptions) {
      scrollTo(this, options);
    },
  });
});

afterEach(() => {
  window.removeEventListener(TOAST_EVENT_NAME, onToast);
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  vi.restoreAllMocks();
});

/** Shows a pending focus request for the doc: a link must not leave one for other panes. */
function FocusProbe() {
  const request = useDocLineFocusRequest(DOC_ID);
  return <output data-testid="focus-probe">{request ? 'pending' : 'none'}</output>;
}

function mount(sourceMode: boolean) {
  const onSave = vi.fn();
  render(
    <div data-testid="scroller" style={{ overflowY: 'auto' }}>
      <WorkspaceEditor
        kind="doc-body"
        savedValue={MD}
        onSave={onSave}
        sourceMode={sourceMode}
        lineLinks={{ docId: DOC_ID, docTitle: 'Plan' }}
      />
      <FocusProbe />
    </div>
  );
  return onSave;
}

/** A click as the browser sends it; returns whether the page's default was canceled. */
function click(target: Element, init: MouseEventInit = {}): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('in-doc heading links in the rendered view', () => {
  const headings = () => Array.from(document.querySelectorAll<HTMLElement>('.ProseMirror h2'));
  const link = (href: string) =>
    document.querySelector<HTMLAnchorElement>(`.ProseMirror a[href="${href}"]`);

  beforeEach(() => {
    // The scroller sits 100px down the window and holds more than it shows;
    // the first Beta is 500px down, the second 700px.
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
      const index = headings().indexOf(this as HTMLElement);
      return rect(index === 0 ? 500 : index === 1 ? 700 : 0);
    });
  });

  async function ready() {
    const onSave = mount(false);
    await screen.findByRole('textbox', { name: 'Doc body' });
    await waitFor(() => expect(headings()).toHaveLength(2));
    await waitFor(() => expect(link('#h=beta-1')).not.toBeNull());
    return onSave;
  }

  it.each([
    ['#h=beta', 0, 500],
    ['#h=beta-1', 1, 700],
    ["GitHub's #beta-1", 1, 700],
  ])('a click on %s scrolls its heading near the top and flashes it', async (name, at, top) => {
    await ready();
    const href = name.replace("GitHub's ", '');
    const before = window.location.href;

    expect(click(link(href)!)).toBe(true);

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(screen.getByTestId('scroller'), {
      top: top - 100 - JUMP_MARGIN,
      behavior: 'smooth',
    });
    expect(headings()[at]).toHaveAttribute('data-line-flash');
    expect(headings()[1 - at]).not.toHaveAttribute('data-line-flash');
    // In place: no navigation, no request another pane would pick up.
    expect(window.location.href).toBe(before);
    expect(screen.getByTestId('focus-probe')).toHaveTextContent('none');
    expect(toasts).not.toHaveBeenCalled();
  });

  it('a link to a missing heading moves nothing and navigates nowhere', async () => {
    const onSave = await ready();
    const before = window.location.href;

    expect(click(link('#q1')!)).toBe(true);

    expect(scrollTo).not.toHaveBeenCalled();
    for (const heading of headings()) expect(heading).not.toHaveAttribute('data-line-flash');
    expect(window.location.href).toBe(before);
    expect(toasts).toHaveBeenCalledWith(expect.stringMatching(/No heading "#q1" in this doc/));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('leaves a drag that ends on a link to the selection', async () => {
    await ready();
    const text = link('#h=beta-1')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    expect(click(link('#h=beta-1')!)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
  });
});

describe('in-doc heading links in the markdown view', () => {
  beforeEach(() => {
    // 20px lines on the styled backdrop.
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      const line = this.parentElement?.getAttribute('data-source-line');
      return line ? Number(line) * 20 : 0;
    });
  });

  async function ready() {
    mount(true);
    return screen.findByTestId<HTMLTextAreaElement>('workspace-editor-source-textarea');
  }

  /** Puts the caret inside the first `text` on the page, as the mousedown of a click does. */
  function caretIn(area: HTMLTextAreaElement, text: string) {
    const at = area.value.indexOf(text) + 2;
    area.setSelectionRange(at, at);
  }

  const flashed = () => document.querySelector('[data-line-flash]');

  it.each([
    ['[Second](#h=beta-1)', 10],
    ['[GitHub](#beta-1)', 10],
    [`[Self](${DOC_ID}#h=beta-1)`, 10],
    ['[First](#h=beta)', 6],
  ])(
    'a Ctrl-click in %s scrolls its heading line near the top and flashes it',
    async (text, index) => {
      const area = await ready();
      caretIn(area, text);

      expect(click(area, { ctrlKey: true })).toBe(true);

      expect(scrollTo).toHaveBeenCalledWith(area, {
        top: index * 20 - JUMP_MARGIN,
        behavior: 'smooth',
      });
      expect(document.querySelector(`[data-source-line="${index}"] > span`)).toHaveAttribute(
        'data-line-flash'
      );
      expect(screen.getByTestId('focus-probe')).toHaveTextContent('none');
    }
  );

  it('a plain click only places the caret', async () => {
    const area = await ready();
    caretIn(area, '[Second](#h=beta-1)');

    expect(click(area)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(flashed()).toBeNull();
  });

  it.each([
    ['a missing heading', '[Gone](#q1)'],
    ['another doc', `[Other](${OTHER_DOC}#h=beta)`],
    ['plain text', '# Alpha'],
  ])('a Ctrl-click on %s moves nothing', async (_name, text) => {
    const area = await ready();
    caretIn(area, text);

    click(area, { ctrlKey: true });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(flashed()).toBeNull();
  });
});
