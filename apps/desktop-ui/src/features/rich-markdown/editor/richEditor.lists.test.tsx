/**
 * Lists in the rich editor: making a list on one line never pulls the text
 * above it into the list, and the everyday list flows (continue with Enter,
 * exit on an empty item, indent, outdent, switch type, toggle off, undo) keep
 * working around headings and plain text.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { installEditorDomShims, mountRichEditor } from './richEditor.testHarness';

beforeAll(installEditorDomShims);

describe('a list made under text leaves the text alone', () => {
  it.each([
    ['/bullet', 'bulletList(listItem(p:item))', '- item'],
    ['/numbered', 'orderedList(listItem(p:item))', '1. item'],
    ['/task', 'taskList(taskItem[ ](p:item))', '- [ ] item'],
  ])('%s on a Shift+Enter line', async (command, list, markdown) => {
    const ed = await mountRichEditor();
    ed.type('regular text');
    ed.press('Enter', { shift: true });
    ed.type(command);
    ed.press('Enter');
    ed.type('item');
    expect(ed.outline()).toEqual(['p:regular text', list]);
    expect(ed.value()).toBe(`regular text\n\n${markdown}`);
  });

  it.each([
    ['8', 'bulletList(listItem(p:item))'],
    ['7', 'orderedList(listItem(p:item))'],
    ['9', 'taskList(taskItem[ ](p:item))'],
  ])('Mod-Shift-%s on the line under the text', async (key, list) => {
    const ed = await mountRichEditor('regular text\\\nitem');
    ed.caretAt('item', 2);
    ed.press(key, { mod: true, shift: true });
    expect(ed.outline()).toEqual(['p:regular text', list]);
  });

  it('a selection over several lines makes one item per line', async () => {
    const ed = await mountRichEditor('intro\\\napples\\\npears\\\noutro');
    ed.select('apples', 'pears');
    ed.press('8', { mod: true, shift: true });
    expect(ed.outline()).toEqual([
      'p:intro',
      'bulletList(listItem(p:apples), listItem(p:pears))',
      'p:outro',
    ]);
    ed.press('z', { mod: true });
    expect(ed.outline()).toEqual(['p:intro⏎apples⏎pears⏎outro']);
  });

  it('a list item typed after a paragraph is its own block', async () => {
    const ed = await mountRichEditor('regular text');
    ed.caretAt('regular text', 12);
    ed.press('Enter');
    ed.type('/bullet');
    ed.press('Enter');
    ed.type('item');
    expect(ed.outline()).toEqual(['p:regular text', 'bulletList(listItem(p:item))']);
  });
});

describe('list flows', () => {
  it('Enter continues the list and Enter on an empty item leaves it', async () => {
    const ed = await mountRichEditor();
    ed.type('- a');
    ed.press('Enter');
    ed.type('b');
    ed.press('Enter');
    ed.press('Enter');
    ed.type('after');
    expect(ed.outline()).toEqual(['bulletList(listItem(p:a), listItem(p:b))', 'p:after']);
    expect(ed.value()).toBe('- a\n- b\n\nafter');
  });

  it('Tab indents and Shift+Tab outdents', async () => {
    const ed = await mountRichEditor();
    ed.type('1. a');
    ed.press('Enter');
    ed.type('b');
    ed.press('Tab');
    expect(ed.outline()).toEqual(['orderedList(listItem(p:a, orderedList(listItem(p:b))))']);
    ed.press('Tab', { shift: true });
    expect(ed.outline()).toEqual(['orderedList(listItem(p:a), listItem(p:b))']);
  });

  it('Enter on an empty nested item outdents it one level', async () => {
    const ed = await mountRichEditor('- a\n  - b');
    ed.caretAt('b', 1);
    ed.press('Enter');
    ed.press('Enter');
    expect(ed.outline()).toEqual([
      'bulletList(listItem(p:a, bulletList(listItem(p:b))), listItem(p:))',
    ]);
  });

  it('task items indent and exit like the other lists', async () => {
    const ed = await mountRichEditor();
    ed.type('[ ] a');
    ed.press('Enter');
    ed.type('b');
    ed.press('Tab');
    ed.press('Enter');
    ed.press('Enter');
    ed.press('Enter');
    ed.type('x');
    expect(ed.outline()).toEqual(['taskList(taskItem[ ](p:a, taskList(taskItem[ ](p:b))))', 'p:x']);
  });

  it('switches a bullet list to a numbered list and back', async () => {
    const ed = await mountRichEditor('- a\n- b');
    ed.caretAt('b', 1);
    ed.press('7', { mod: true, shift: true });
    expect(ed.outline()).toEqual(['orderedList(listItem(p:a), listItem(p:b))']);
    ed.press('8', { mod: true, shift: true });
    expect(ed.outline()).toEqual(['bulletList(listItem(p:a), listItem(p:b))']);
  });

  it('toggling the list off turns only the current item into text', async () => {
    const ed = await mountRichEditor('- a\n- b');
    ed.caretAt('b', 1);
    ed.press('8', { mod: true, shift: true });
    expect(ed.outline()).toEqual(['bulletList(listItem(p:a))', 'p:b']);
  });

  it('Backspace at the start of an item turns it into text', async () => {
    const ed = await mountRichEditor('- a\n- b');
    ed.caretAt('b');
    ed.press('Backspace');
    expect(ed.outline()).toEqual(['bulletList(listItem(p:a))', 'p:b']);
  });

  it('a list right under a heading stays separate from it', async () => {
    const ed = await mountRichEditor('### Head');
    ed.caretAt('Head', 4);
    ed.press('Enter');
    ed.type('- x');
    expect(ed.outline()).toEqual(['h3:Head', 'bulletList(listItem(p:x))']);
    expect(ed.value()).toBe('### Head\n\n- x');
  });

  it('undo steps back through the typed item, then the list', async () => {
    const ed = await mountRichEditor('text');
    ed.caretAt('text', 4);
    ed.press('Enter');
    ed.type('- x');
    ed.press('z', { mod: true });
    ed.press('z', { mod: true });
    expect(ed.outline()).toEqual(['p:text']);
    ed.press('z', { mod: true, shift: true });
    ed.press('z', { mod: true, shift: true });
    expect(ed.outline()).toEqual(['p:text', 'bulletList(listItem(p:x))']);
  });
});
