/**
 * Right-click in the rich editor opens a format menu: "turn into" block types
 * for exactly the blocks under the selection, inline marks for the selected
 * text, then Cut / Copy / Paste. Checked items show what is already applied.
 */
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { installEditorDomShims, mountRichEditor } from './richEditor.testHarness';

beforeAll(installEditorDomShims);

const menu = () => screen.queryByRole('menu', { name: 'Format' });
const menuItems = () =>
  Array.from(
    menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]')
  );
// Items with a check mark or shortcut wrap their label in its own span.
const labelOf = (el: HTMLElement) =>
  el.querySelector('[class*="label"]')?.textContent ?? el.textContent ?? '';
const item = (name: string) => {
  const found = menuItems().find((el) => labelOf(el) === name);
  if (!found) throw new Error(`no menu item ${name}`);
  return found;
};

function openMenu(box: HTMLElement) {
  fireEvent.contextMenu(box, { clientX: 40, clientY: 40 });
  expect(menu()).toBeInTheDocument();
}

function pick(name: string) {
  fireEvent.click(item(name));
}

describe('format context menu', () => {
  it('lists the block types, the inline formats and the clipboard actions', async () => {
    const ed = await mountRichEditor('text');
    ed.caretAt('text', 2);
    openMenu(ed.box);
    expect(menuItems().map(labelOf)).toEqual([
      'Text',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Bullet list',
      'Numbered list',
      'Task list',
      'Quote',
      'Code block',
      'Bold',
      'Italic',
      'Strikethrough',
      'Inline code',
      'Link…',
      'Cut',
      'Copy',
      'Paste',
    ]);
    // Shortcuts that exist are shown (Ctrl under jsdom, which is not a Mac).
    expect(item('Heading 2')).toHaveAttribute('aria-keyshortcuts', 'Ctrl+Alt+2');
    expect(item('Bold')).toHaveAttribute('aria-keyshortcuts', 'Ctrl+B');
  });

  it('turns a highlighted chunk of a paragraph into a heading and keeps the selection', async () => {
    const ed = await mountRichEditor('one\n\ntwo words\n\nthree');
    ed.select('two', 'words');
    openMenu(ed.box);
    pick('Heading 2');
    expect(menu()).not.toBeInTheDocument();
    expect(ed.outline()).toEqual(['p:one', 'h2:two words', 'p:three']);
    const { from, to } = ed.editor().state.selection;
    expect(ed.editor().state.doc.textBetween(from, to)).toBe('two words');
  });

  it('converts every block of a multi-block selection', async () => {
    const ed = await mountRichEditor('one\n\ntwo\n\nthree\n\nfour');
    ed.select('two', 'three');
    openMenu(ed.box);
    pick('Bullet list');
    expect(ed.outline()).toEqual([
      'p:one',
      'bulletList(listItem(p:two), listItem(p:three))',
      'p:four',
    ]);
  });

  it('with a collapsed caret, converts the current block only, even on a Shift+Enter line', async () => {
    const ed = await mountRichEditor('above\\\ncurrent');
    ed.caretAt('current', 3);
    openMenu(ed.box);
    pick('Quote');
    expect(ed.outline()).toEqual(['p:above', 'blockquote(p:current)']);
  });

  it('checks the formats already applied, and picking a checked one turns it off', async () => {
    const ed = await mountRichEditor('### head **bold**');
    ed.select('bold', 'bold');
    openMenu(ed.box);
    expect(item('Heading 3')).toHaveAttribute('aria-checked', 'true');
    expect(item('Heading 2')).toHaveAttribute('aria-checked', 'false');
    expect(item('Bold')).toHaveAttribute('aria-checked', 'true');
    expect(item('Italic')).toHaveAttribute('aria-checked', 'false');
    pick('Bold');
    expect(ed.value()).toBe('### head bold');
  });

  it('applies inline formats to the selected text', async () => {
    const ed = await mountRichEditor('make this code');
    ed.select('code', 'code');
    openMenu(ed.box);
    pick('Inline code');
    expect(ed.value()).toBe('make this `code`');
  });

  it('a format is one undo step', async () => {
    const ed = await mountRichEditor('one\\\ntwo');
    ed.caretAt('two');
    openMenu(ed.box);
    pick('Heading 1');
    expect(ed.outline()).toEqual(['p:one', 'h1:two']);
    ed.press('z', { mod: true });
    expect(ed.outline()).toEqual(['p:one⏎two']);
  });

  it('Text lifts a list item back to a paragraph', async () => {
    const ed = await mountRichEditor('- a\n- b');
    ed.caretAt('b');
    openMenu(ed.box);
    expect(item('Text')).toHaveAttribute('aria-checked', 'false');
    expect(item('Bullet list')).toHaveAttribute('aria-checked', 'true');
    pick('Text');
    expect(ed.outline()).toEqual(['bulletList(listItem(p:a))', 'p:b']);
  });

  it('is keyboard driven: arrows move, Enter picks, Escape closes', async () => {
    const ed = await mountRichEditor('text');
    ed.caretAt('text', 1);
    openMenu(ed.box);
    const user = userEvent.setup({ delay: null });
    expect(item('Text')).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(item('Heading 2')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(menu()).not.toBeInTheDocument();
    expect(ed.outline()).toEqual(['h2:text']);

    openMenu(ed.box);
    await user.keyboard('{Escape}');
    expect(menu()).not.toBeInTheDocument();
  });

  it('Link… asks for the address and links the selected text', async () => {
    const ed = await mountRichEditor('see the site');
    ed.select('site', 'site');
    openMenu(ed.box);
    pick('Link…');
    const input = await screen.findByRole('textbox', { name: 'Link address' });
    expect(input).toHaveFocus();
    const user = userEvent.setup({ delay: null });
    await user.type(input, 'https://example.com{Enter}');
    expect(ed.value()).toBe('see the [site](https://example.com)');
    expect(screen.queryByRole('textbox', { name: 'Link address' })).not.toBeInTheDocument();
  });

  it('Link… on a link edits its address, and an empty address removes the link', async () => {
    const ed = await mountRichEditor('see [site](https://old.test)');
    ed.caretAt('site', 2);
    openMenu(ed.box);
    expect(item('Link…')).toHaveAttribute('aria-checked', 'true');
    pick('Link…');
    const input = await screen.findByRole('textbox', { name: 'Link address' });
    expect(input).toHaveValue('https://old.test');
    const user = userEvent.setup({ delay: null });
    await user.clear(input);
    await user.keyboard('{Enter}');
    expect(ed.value()).toBe('see site');
  });

  it('Open link leads the menu on a web link and opens it in the browser', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const ed = await mountRichEditor('see [site](https://example.org/) and [notes](./notes.md)');
    const anchor = (href: string) => ed.box.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!;

    fireEvent.contextMenu(anchor('https://example.org/'), { clientX: 40, clientY: 40 });
    expect(menuItems().map(labelOf).slice(0, 2)).toEqual(['Open link', 'Text']);
    pick('Open link');
    expect(menu()).not.toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://example.org/', '_blank', 'noopener');

    // A relative link and plain text have nothing to open outside the app.
    fireEvent.contextMenu(anchor('./notes.md'), { clientX: 40, clientY: 40 });
    expect(menuItems().map(labelOf)).not.toContain('Open link');
    fireEvent.keyDown(menu()!, { key: 'Escape' });
    openMenu(ed.box);
    expect(menuItems().map(labelOf)).not.toContain('Open link');
    open.mockRestore();
  });

  it('Cut and Copy need a selection', async () => {
    const ed = await mountRichEditor('text');
    ed.caretAt('text', 1);
    openMenu(ed.box);
    expect(item('Cut')).toBeDisabled();
    expect(item('Copy')).toBeDisabled();
    expect(item('Paste')).toBeEnabled();
  });

  it('does not open on a read-only editor', async () => {
    const ed = await mountRichEditor('text');
    act(() => ed.editor().setEditable(false));
    fireEvent.contextMenu(ed.box, { clientX: 10, clientY: 10 });
    expect(menu()).not.toBeInTheDocument();
  });
});
