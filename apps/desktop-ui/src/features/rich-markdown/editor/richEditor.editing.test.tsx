/**
 * Everyday editing keys in the rich editor behave like Google Docs: Enter
 * after a heading starts text, Backspace at the start of a formatted block
 * turns it back into text before it merges anything, and the slash menu
 * leaves no stray characters behind.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { installEditorDomShims, mountRichEditor } from './richEditor.testHarness';

beforeAll(installEditorDomShims);

describe('Enter and Backspace around headings', () => {
  it('Enter at the end of a heading starts a paragraph', async () => {
    const ed = await mountRichEditor();
    ed.type('# Title');
    ed.press('Enter');
    ed.type('body');
    expect(ed.outline()).toEqual(['h1:Title', 'p:body']);
  });

  it('Backspace at the start of a heading turns it into text first', async () => {
    const ed = await mountRichEditor('para\n\n### head');
    ed.caretAt('head');
    ed.press('Backspace');
    expect(ed.outline()).toEqual(['p:para', 'p:head']);
    ed.press('Backspace');
    expect(ed.outline()).toEqual(['p:parahead']);
  });

  it('Backspace at the start of a quote lifts it out first', async () => {
    const ed = await mountRichEditor('para\n\n> q');
    ed.caretAt('q');
    ed.press('Backspace');
    expect(ed.outline()).toEqual(['p:para', 'p:q']);
  });

  it('Backspace inside a heading leaves it a heading', async () => {
    // jsdom has no native character deletion; the heading must just not
    // turn into text.
    const ed = await mountRichEditor('## head');
    ed.caretAt('head', 2);
    ed.press('Backspace');
    expect(ed.outline()).toEqual(['h2:head']);
  });
});

describe('slash menu', () => {
  it('leaves no slash and no stray space after the line it converts', async () => {
    const ed = await mountRichEditor();
    ed.type('hello /h2');
    ed.press('Enter');
    expect(ed.outline()).toEqual(['h2:hello']);
    expect(ed.value()).toBe('## hello');
  });

  it('a command picked mid-line keeps the space between the words', async () => {
    const ed = await mountRichEditor('hello world');
    ed.caretAt('world');
    ed.type('/h3');
    ed.press('Enter');
    expect(ed.outline()).toEqual(['h3:hello world']);
  });

  it('a command on an empty line leaves the line empty', async () => {
    const ed = await mountRichEditor('text');
    ed.caretAt('text', 4);
    ed.press('Enter');
    ed.type('/quote');
    ed.press('Enter');
    ed.type('q');
    expect(ed.outline()).toEqual(['p:text', 'blockquote(p:q)']);
  });
});
