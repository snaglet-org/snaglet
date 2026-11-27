import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { LinkOpen } from './linkOpen';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { ChipEditableInput } from './ChipEditableInput';

const DOC_ID = 'doc-1111111111111-aaaaaaaaa';
const editors: Editor[] = [];

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** jsdom reports a non-Apple platform, so the open-link modifier is Ctrl. */
function click(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  target.dispatchEvent(event);
  return event;
}

function mountEditor(
  html: string | Record<string, unknown>,
  openUrl = vi.fn(() => Promise.resolve())
) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ link: { autolink: false, openOnClick: false } }),
      LinkOpen.configure({ openUrl }),
    ],
    content: html,
  });
  editors.push(editor);
  return { editor, openUrl };
}

function link(editor: Editor, href: string): HTMLAnchorElement {
  const a = editor.view.dom.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
  if (!a) throw new Error(`no link to ${href}`);
  return a;
}

describe('LinkOpen in an editable doc', () => {
  it('opens a web link on Ctrl-click and leaves a plain click to the caret', () => {
    const { editor, openUrl } = mountEditor(
      '<p>See <a href="https://example.org/docs">docs</a></p>'
    );
    const a = link(editor, 'https://example.org/docs');

    const plain = click(a.firstElementChild ?? a);
    expect(openUrl).not.toHaveBeenCalled();
    expect(plain.defaultPrevented).toBe(false);

    const mod = click(a.firstElementChild ?? a, { ctrlKey: true });
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith('https://example.org/docs');
    expect(mod.defaultPrevented).toBe(true);
  });

  it('uses ⌘ rather than Ctrl on macOS', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const { editor, openUrl } = mountEditor('<p><a href="mailto:user@example.com">mail</a></p>');
    const a = link(editor, 'mailto:user@example.com');
    click(a, { ctrlKey: true });
    expect(openUrl).not.toHaveBeenCalled();
    click(a, { metaKey: true });
    expect(openUrl).toHaveBeenCalledWith('mailto:user@example.com');
  });

  it('claims the modified click so ProseMirror does not node-select the paragraph', () => {
    const { editor } = mountEditor('<p><a href="https://example.org/">site</a> and text</p>');
    const a = link(editor, 'https://example.org/');
    // ProseMirror asks `handleClick` on mouseup before it would node-select.
    const claimed = (target: Element, init: MouseEventInit) => {
      const event = new MouseEvent('mouseup', { button: 0, ...init });
      Object.defineProperty(event, 'target', { value: target });
      return editor.view.someProp('handleClick', (f) => f(editor.view, 2, event)) ?? false;
    };
    expect(claimed(a, { ctrlKey: true })).toBe(true);
    expect(claimed(a, {})).toBe(false);
    expect(claimed(editor.view.dom.querySelector('p')!, { ctrlKey: true })).toBe(false);
  });

  it('never launches unsafe schemes, relative links or the app itself', () => {
    // JSON content, so even a `javascript:` mark the parser would refuse is
    // in the doc and rendered.
    const linked = (href: string) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }],
    });
    const { editor, openUrl } = mountEditor({
      type: 'doc',
      content: [
        './notes.md',
        '/dashboard',
        `${window.location.origin}/x`,
        'tel:+15555550100',
        'javascript:alert(1)',
        'file:///etc/hosts',
      ].map(linked),
    });
    const anchors = [...editor.view.dom.querySelectorAll('a')];
    expect(anchors).toHaveLength(6);
    for (const a of anchors) {
      const event = click(a, { ctrlKey: true });
      expect(event.defaultPrevented, a.textContent ?? '').toBe(false);
    }
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('labels external links with how to open them, outside the stored doc', () => {
    const { editor } = mountEditor(
      '<p><a href="https://example.org/">site</a> <a href="./notes.md">notes</a></p>'
    );
    const hint = link(editor, 'https://example.org/').querySelector('[title]');
    expect(hint?.getAttribute('title')).toBe(
      'Right-click or Ctrl-click to open https://example.org/'
    );
    expect(link(editor, './notes.md').querySelector('[title]')).toBeNull();
    const marks = editor.getJSON().content?.[0]?.content?.[0]?.marks;
    expect(marks).toEqual([
      expect.objectContaining({ attrs: expect.objectContaining({ title: null }) }),
    ]);
  });

  it('leaves links alone once the editor is read-only', () => {
    const { editor, openUrl } = mountEditor('<p><a href="https://example.org/">site</a></p>');
    editor.setEditable(false);
    click(link(editor, 'https://example.org/'), { ctrlKey: true });
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe('ChipEditableInput rich links', () => {
  it('opens a web link on Ctrl-click but never sends a node chip to the browser', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onChange = vi.fn();
    const value = `See [Spec](${DOC_ID}) and [site](https://example.org/).`;
    const { container } = render(
      <ChipEditableInput
        value={value}
        onChange={onChange}
        ariaLabel="Doc body"
        richBlocks
        multiline
        enableNodeMentions={false}
      />
    );
    const site = await waitFor(() => {
      const a = container.querySelector<HTMLAnchorElement>('a[href="https://example.org/"]');
      expect(a).not.toBeNull();
      return a!;
    });
    const chip = container.querySelector(`[data-node-id="${DOC_ID}"]`);
    expect(chip).not.toBeNull();

    click(chip!, { ctrlKey: true });
    click(site);
    expect(open).not.toHaveBeenCalled();

    click(site, { ctrlKey: true });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://example.org/', '_blank', 'noopener');
    expect(onChange).not.toHaveBeenCalled();
  });
});
