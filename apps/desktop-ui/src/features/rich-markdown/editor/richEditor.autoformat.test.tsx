/**
 * Markdown typed into the rich editor formats as you type, the way Google
 * Docs autoformats: block prefixes at the start of a line, inline marks when
 * the closing character lands. Each test types character by character, so
 * the input rules run as they do for a user.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { installEditorDomShims, mountRichEditor } from './richEditor.testHarness';

beforeAll(installEditorDomShims);

const DOC_ID = 'doc-1111111111111-9gqbtkgh1';

describe('typed links', () => {
  it('a typed node-ref link still becomes a chip', async () => {
    const ed = await mountRichEditor();
    ed.type(`see [Spec](${DOC_ID})`);
    expect(ed.outline()).toEqual(['p:see ◆']);
    expect(ed.value()).toBe(`see [Spec](${DOC_ID})`);
  });

  it('a typed web link never turns into an empty chip', async () => {
    const ed = await mountRichEditor();
    ed.type('see [site](https://example.com)');
    expect(ed.outline()).not.toEqual(['p:see ◆']);
    expect(ed.value()).not.toContain('[]()');
    expect(ed.editor().state.doc.textContent).toContain('site');
  });

  it('[text](url) becomes a link when the closing parenthesis is typed', async () => {
    const ed = await mountRichEditor();
    ed.type('see [site](https://example.com) now');
    expect(ed.outline()).toEqual(['p:see site now']);
    expect(ed.value()).toBe('see [site](https://example.com) now');
    expect(ed.editor().isActive('link')).toBe(false);
  });

  it('bold typed around a typed link wraps the link', async () => {
    const ed = await mountRichEditor();
    ed.type('**[bold](https://example.com)');
    ed.type('**');
    // The serializer puts the emphasis inside the link; both read the same.
    expect(ed.value()).toBe('[**bold**](https://example.com)');
  });

  it('leaves markdown image syntax as text', async () => {
    const ed = await mountRichEditor();
    ed.type('![alt](https://example.com/a.png)');
    expect(ed.value()).toBe('!\\[alt\\](https://example.com/a.png)');
  });
});

describe('undoing an autoformat brings back what was typed', () => {
  // At the end of the doc the trailing-node plugin appends a paragraph after
  // the new block; undo must still reverse the autoformat there.
  it.each([
    ['## ', 'p:## '],
    ['- ', 'p:- '],
    ['> ', 'p:> '],
    ['1. ', 'p:1. '],
  ])('Backspace right after "%s" at the end of the doc', async (typed, restored) => {
    const ed = await mountRichEditor('text');
    ed.caretAt('text', 4);
    ed.press('Enter');
    ed.type(typed);
    ed.press('Backspace');
    expect(ed.outline()).toEqual(['p:text', restored]);
  });

  it('Mod-z right after "### " restores the typed text, a second Mod-z undoes the typing', async () => {
    const ed = await mountRichEditor('text');
    ed.caretAt('text', 4);
    ed.press('Enter');
    ed.type('### ');
    expect(ed.outline()).toEqual(['p:text', 'h3:']);
    ed.press('z', { mod: true });
    expect(ed.outline()).toEqual(['p:text', 'p:### ']);
    ed.press('z', { mod: true });
    expect(ed.outline()).toEqual(['p:text']);
  });

  it('Mod-z after an inline autoformat restores the markers', async () => {
    const ed = await mountRichEditor();
    ed.type('a **b**');
    ed.press('z', { mod: true });
    expect(ed.value()).toBe('a \\*\\*b\\*\\*');
  });

  it('Mod-z after typing on past an autoformat is a normal undo', async () => {
    const ed = await mountRichEditor('text');
    ed.caretAt('text', 4);
    ed.press('Enter');
    ed.type('## Title');
    ed.press('z', { mod: true });
    expect(ed.outline()).toEqual(['p:text']);
  });
});

describe('block markdown typed at the start of a line', () => {
  it.each([
    ['- item', 'bulletList(listItem(p:item))'],
    ['* item', 'bulletList(listItem(p:item))'],
    ['+ item', 'bulletList(listItem(p:item))'],
    ['1. item', 'orderedList(listItem(p:item))'],
    ['[ ] item', 'taskList(taskItem[ ](p:item))'],
    ['> item', 'blockquote(p:item)'],
    ['### item', 'h3:item'],
    ['---', 'horizontalRule'],
  ])('"%s" after Shift+Enter formats only that line', async (typed, block) => {
    const ed = await mountRichEditor();
    ed.type('regular text');
    ed.press('Enter', { shift: true });
    ed.type(typed);
    expect(ed.outline()).toEqual(['p:regular text', block]);
  });

  it('"## " at the start of a paragraph with more lines formats only the first line', async () => {
    const ed = await mountRichEditor('one\\\ntwo');
    ed.caretAt('one');
    ed.type('## ');
    expect(ed.outline()).toEqual(['h2:one', 'p:two']);
  });

  it('a line in the middle of a paragraph is split out on its own', async () => {
    const ed = await mountRichEditor('one\\\ntwo\\\nthree');
    ed.caretAt('two');
    ed.type('- ');
    expect(ed.outline()).toEqual(['p:one', 'bulletList(listItem(p:two))', 'p:three']);
  });

  it.each(['- ', '* ', '# ', '> ', '1. '])(
    '"%s" in the middle of a line stays text',
    async (typed) => {
      const ed = await mountRichEditor();
      ed.type('a');
      ed.press('Enter', { shift: true });
      ed.type(`x ${typed}`);
      expect(ed.outline()).toEqual([`p:a⏎x ${typed}`]);
    }
  );

  it('Backspace right after the autoformat puts the typed text back on that line', async () => {
    const ed = await mountRichEditor();
    ed.type('regular text');
    ed.press('Enter', { shift: true });
    ed.type('- ');
    ed.press('Backspace');
    expect(ed.outline()).toEqual(['p:regular text', 'p:- ']);
  });
});

describe('code fences', () => {
  it('Enter after "```" on its own line opens a code block', async () => {
    const ed = await mountRichEditor('text');
    ed.caretAt('text', 4);
    ed.press('Enter');
    ed.type('```');
    ed.press('Enter');
    ed.type('const x = 1;');
    expect(ed.outline()).toEqual(['p:text', 'code:const x = 1;']);
    expect(ed.value()).toBe('text\n\n```\nconst x = 1;\n```');
  });

  it('keeps the language typed after the fence', async () => {
    const ed = await mountRichEditor();
    ed.type('```ts');
    ed.press('Enter');
    ed.type('let a');
    expect(ed.value()).toBe('```ts\nlet a\n```');
  });

  it.each([
    ['Mod-z', 'z', { mod: true }],
    ['Backspace', 'Backspace', {}],
  ] as const)(
    '%s right after turns the code block back into the typed fence, no stray newline',
    async (_label, key, mods) => {
      const ed = await mountRichEditor();
      ed.type('```');
      ed.press('Enter');
      ed.press(key, mods);
      expect(ed.outline()).toEqual(['p:```']);
      expect(ed.value()).toBe('\\`\\`\\`');
    }
  );

  it('Enter after "```" with text before it on the line just splits the line', async () => {
    const ed = await mountRichEditor();
    ed.type('see ```');
    ed.press('Enter');
    expect(ed.outline()).toEqual(['p:see ```']);
  });
});
