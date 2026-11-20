/**
 * Pasting plain text into the rich editor: markdown turns into blocks, and
 * the line breaks of the pasted text stay line breaks.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { installEditorDomShims, mountRichEditor } from './richEditor.testHarness';

beforeAll(installEditorDomShims);

describe('pasting plain text', () => {
  it('pasted markdown turns into blocks', async () => {
    const ed = await mountRichEditor();
    ed.paste('# Title\n\n- a\n- b\n\n> quote');
    expect(ed.outline()).toEqual([
      'h1:Title',
      'bulletList(listItem(p:a), listItem(p:b))',
      'blockquote(p:quote)',
    ]);
  });

  it('keeps each pasted line on its own line', async () => {
    const ed = await mountRichEditor();
    ed.paste('first line\nsecond line\nthird line');
    expect(ed.outline()).toEqual(['p:first line', 'p:second line', 'p:third line']);
  });

  it('keeps a label line above its text', async () => {
    const ed = await mountRichEditor();
    ed.paste('**Summary**\nSome text here');
    expect(ed.value()).toBe('**Summary**\n\nSome text here');
  });

  it('keeps emphasis that spans a line break on one paragraph', async () => {
    const ed = await mountRichEditor();
    ed.paste('**bold\nstill bold**');
    expect(ed.value()).toBe('**bold still bold**');
  });

  it('keeps code blocks verbatim', async () => {
    const ed = await mountRichEditor();
    ed.paste('```\na\nb\n```');
    expect(ed.outline()).toEqual(['code:a\nb']);
  });
});
