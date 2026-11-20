/**
 * Doc line links (`[Doc › L3–5](doc-…#L3-L5)`) render as doc chips with
 * their range everywhere a plain doc link does: the renderer (docs, chat,
 * previews) and the rich editor. The range may be written the way the chip
 * label reads it (`#L3–5`, `#L3-5`), and markdown parsers percent-encode
 * the en dash in an href.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) } };
});

import { markdownForChatMessageRender } from '@desktop/pages/Dashboard/views/ChatView/chatMarkdown';
import { MarkdownRenderer } from './MarkdownRenderer';
import { NODE_HREF_SOURCE, parseNodeRef } from './nodeRef';
import {
  installEditorDomShims,
  mountRichEditor,
} from '@desktop/features/rich-markdown/editor/richEditor.testHarness';

beforeAll(installEditorDomShims);
afterEach(cleanup);

const ID = 'doc-1794864925672-y0r38dfw5';
const LABEL = 'Getting Started Worksheet › L3–5';
/** The chip draws the range as its own badge, so a label that ends with it
 *  shows just the doc title. */
const SHOWN_TITLE = 'Getting Started Worksheet';
const LINK = `[${LABEL}](${ID}#L3-L5)`;

/** Hrefs the way they get written, and the range each means. */
const WRITTEN: Array<[string, string]> = [
  ['#L3-L5', 'L3–5'],
  ['#L7', 'L7'],
  ['#L3-5', 'L3–5'],
  ['#L3–5', 'L3–5'],
  ['#L3–L5', 'L3–5'],
  ['#l3-l5', 'L3–5'],
];

function chipsIn(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.md-chip')).map((chip) => ({
    id: chip.getAttribute('data-node-id'),
    title: chip.querySelector('.md-chip-title')?.textContent,
    lines: chip.querySelector('.md-chip-lines')?.textContent,
  }));
}

describe('line links in the renderer', () => {
  it.each(WRITTEN)('renders `%s` as a doc chip with its range', (fragment, range) => {
    const label = `Getting Started Worksheet › ${range}`;
    const { container } = render(<MarkdownRenderer content={`see [${label}](${ID}${fragment})`} />);
    expect(chipsIn(container)).toEqual([{ id: ID, title: SHOWN_TITLE, lines: range }]);
  });

  it.each([
    ['a label that names the range another way', 'Worksheet › L3-L5', 'Worksheet'],
    ['a label with a different range', 'Worksheet › L7', 'Worksheet › L7'],
    ['a label that names something else', 'Setup › Step two', 'Setup › Step two'],
    ['a label that is only the range', 'L3–5', 'L3–5'],
  ])('shows the range once for %s', (_case, label, shown) => {
    const { container } = render(<MarkdownRenderer content={`[${label}](${ID}#L3-L5)`} />);
    expect(chipsIn(container)).toEqual([{ id: ID, title: shown, lines: 'L3–5' }]);
  });

  it('renders them in a list item, several on one line, and in a chat message', () => {
    const content = `- ${LINK}\n- ${LINK} and [Other › L7](${ID}#L7)`;
    const { container } = render(<MarkdownRenderer content={content} />);
    expect(chipsIn(container).map((chip) => chip.lines)).toEqual(['L3–5', 'L3–5', 'L7']);
    cleanup();
    const chat = render(
      <MarkdownRenderer content={markdownForChatMessageRender(`look:\n${LINK}\nthanks`)} />
    );
    expect(chipsIn(chat.container)).toEqual([{ id: ID, title: SHOWN_TITLE, lines: 'L3–5' }]);
  });

  it('parses the percent-encoded en dash a markdown parser leaves in the href', () => {
    expect(parseNodeRef(`${ID}#L3%E2%80%935`)).toEqual({
      kind: 'doc',
      id: ID,
      anchor: { lines: { startLine: 3, endLine: 5 } },
    });
  });

  it('picks up a bare line link written with an en dash whole', () => {
    const match = new RegExp(NODE_HREF_SOURCE).exec(`see ${ID}#L3–5 here`);
    expect(match?.[0]).toBe(`${ID}#L3–5`);
  });
});

describe('line links in the rich editor', () => {
  function chipHrefs(ed: Awaited<ReturnType<typeof mountRichEditor>>) {
    const hrefs: string[] = [];
    ed.editor().state.doc.descendants((node) => {
      if (node.type.name === 'chip') hrefs.push(String(node.attrs.href));
    });
    return hrefs;
  }

  it('shows the range once on the chip, and keeps the full label in the saved link', async () => {
    const ed = await mountRichEditor(`see ${LINK}`);
    const chip = ed.box.querySelector('.md-chip');
    expect(chip?.querySelector('.md-chip-title')?.textContent).toBe(SHOWN_TITLE);
    expect(chip?.querySelector('.md-chip-lines')?.textContent).toBe('L3–5');
    ed.caretAt('see', 0);
    ed.type('I ');
    expect(ed.value()).toBe(`I see ${LINK}`);
  });

  it('parses the reported link into a doc chip and saves it back exactly', async () => {
    const ed = await mountRichEditor(`see ${LINK}\n\n- ${LINK} and ${LINK}`);
    expect(chipHrefs(ed)).toEqual([`${ID}#L3-L5`, `${ID}#L3-L5`, `${ID}#L3-L5`]);
    ed.caretAt('see', 0);
    ed.type('I ');
    expect(ed.value()).toBe(`I see ${LINK}\n\n- ${LINK} and ${LINK}`);
  });

  it.each(WRITTEN.slice(2))(
    'parses `%s` into a chip and saves the canonical range',
    async (fragment) => {
      const ed = await mountRichEditor(`see [${LABEL}](${ID}${fragment})`);
      expect(chipHrefs(ed)).toHaveLength(1);
      ed.caretAt('see', 0);
      ed.type('I ');
      expect(ed.value()).toBe(`I see ${LINK}`);
    }
  );
});

describe('copying a rendered chip into the rich editor', () => {
  beforeAll(() => {
    (globalThis as Record<string, unknown>).ClipboardEvent ??= class extends Event {
      clipboardData = null;
    };
  });

  it.each([
    ['a line link', `${ID}#L3-L5`, LINK],
    ['a plain doc link', ID, `[${LABEL}](${ID})`],
  ])('pastes %s copied from a preview or chat as the same chip', async (_label, href, saved) => {
    const rendered = render(<MarkdownRenderer content={`see [${LABEL}](${href}) end`} />);
    const html = rendered.container.querySelector('p')!.outerHTML;
    rendered.unmount();

    const ed = await mountRichEditor('x');
    ed.caretAt('x', 1);
    act(() => {
      ed.editor().view.pasteHTML(html);
    });
    const chips: Array<Record<string, unknown>> = [];
    ed.editor().state.doc.descendants((node) => {
      if (node.type.name === 'chip') chips.push(node.attrs);
    });
    expect(chips).toEqual([expect.objectContaining({ kind: 'doc', href, title: LABEL })]);
    expect(ed.value()).toBe(`xsee ${saved} end`);
  });
});
