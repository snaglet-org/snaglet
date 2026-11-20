// Full markdown round-trip for the rich block editor, via
// prosemirror-markdown: headings, lists (with GFM task lists), code, quotes,
// rules, tables and inline marks. Node-ref links parse into chip nodes, and
// chips serialize back to the markdown MarkdownRenderer reads. `markdown.ts`
// handles the paragraphs-and-chips-only mode.

import type { Editor } from '@tiptap/react';
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownSerializer,
  type MarkdownSerializerState,
} from 'prosemirror-markdown';
import MarkdownIt from 'markdown-it';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import Token from 'markdown-it/lib/token.mjs';
import {
  BARE_TABLE_ID_SOURCE,
  NODE_HREF_SOURCE,
  TOOL_HREF_SOURCE,
  canonicalNodeHref,
  idOnlyChipValue,
  parseNodeRef,
  tableChipHrefForBareId,
} from '@desktop/features/rich-markdown/renderer/nodeRef';
import {
  agentMentionMarkdown,
  agentMentionsToMarkdownLinksWithAgents,
} from '@desktop/utils/agentMentionMarkdown';
import { isMermaidBlock } from '../renderer/isMermaidBlock';
import { getAgentsCached } from './agentMentionCache';
import { escapeChipTitle } from '@desktop/utils/nodeChip';

const BARE_ID_RE = new RegExp(NODE_HREF_SOURCE, 'g');
// Id-only inputs also store a table chip as its bare catalog id and a tool
// chip as its `tool:<slug id>` href; prose chips neither.
const ID_ONLY_BARE_RE = new RegExp(
  `${TOOL_HREF_SOURCE}|${NODE_HREF_SOURCE}|${BARE_TABLE_ID_SOURCE}`,
  'g'
);

interface BareIdOptions {
  parseBareIds: boolean;
  /** Also chip bare table catalog ids and `tool:<slug id>` hrefs (with
   *  `parseBareIds`). Id-only (`passIdOnly`) inputs only: prose never chips a
   *  bare `table-…` or `tool:create`. */
  parseBareTableIds: boolean;
}

const TASK_MARKER_RE = /^\[([ xX])\] /;

// CommonMark without HTML (unsupported syntax stays literal and round-trips
// verbatim), plus GFM strikethrough and pipe tables.
const md = MarkdownIt('commonmark', { html: false }).enable(['strikethrough', 'table']);

// A table cell's line that starts with a task marker is a task item: `[ ]` or
// `[x]` (what the editor writes and agents and GFM tools read), or `☐` / `☑`,
// which older saves wrote. The marker stands alone: a space, a `<br>` or the
// cell's end follows it.
const CELL_TASK_RE = /(^|<br\s*\/?>)[ \t]*(\[([ xX])\]|☐|☑)(?:[ \t]|(?=<br)|$)/gi;
/** The token `markCellTasks` puts in place of a marker; `meta.checked` holds its state. */
const CELL_TASK = 'snaglet_cell_task';

function textToken(content: string): Token {
  const token = new Token('text', '', 0);
  token.content = content;
  return token;
}

/**
 * A cell's inline tokens with each line-start task marker in plain text (at
 * the cell's start, or after a `<br>`) taken out as a `CELL_TASK` token.
 * Text inside emphasis, a link or other markup stays text.
 */
function splitCellTasks(children: Token[]): Token[] {
  const out: Token[] = [];
  let depth = 0;
  children.forEach((child, index) => {
    const outside = depth === 0;
    depth += child.nesting;
    if (child.type !== 'text' || !outside) {
      out.push(child);
      return;
    }
    const last = index === children.length - 1;
    let from = 0;
    for (const match of child.content.matchAll(CELL_TASK_RE)) {
      const [whole, lineStart, marker, box] = match;
      const end = match.index + whole.length;
      if (!lineStart && index > 0) continue;
      if (!/[ \t]$/.test(whole) && end === child.content.length && !last) continue;
      const before = child.content.slice(from, match.index) + lineStart;
      if (before) out.push(textToken(before));
      const task = new Token(CELL_TASK, '', 0);
      task.meta = { checked: box === undefined ? marker === '☑' : box !== ' ' };
      out.push(task);
      from = end;
    }
    if (from === 0) out.push(child);
    else if (from < child.content.length) out.push(textToken(child.content.slice(from)));
  });
  return out;
}

/**
 * Take the task markers out of every table cell. It runs before escapes join
 * the text around them, so an escaped `\[ \]` stays text; inline code, links
 * and chips are tokens of their own and never match.
 */
function markCellTasks(state: StateCore): void {
  let inCell = false;
  for (const token of state.tokens) {
    if (token.type === 'th_open' || token.type === 'td_open') inCell = true;
    else if (token.type === 'th_close' || token.type === 'td_close') inCell = false;
    else if (inCell && token.type === 'inline' && token.children)
      token.children = splitCellTasks(token.children);
  }
}
md.core.ruler.before('text_join', 'snaglet_cell_tasks', markCellTasks);

// markdown-it refuses `file:` links, which would leave a saved file chip
// (`[name](file:/abs/path)`) as literal text. Node refs become chips, never
// navigable links, so they bypass the check; every other href keeps it.
const validateLinkDefault = md.validateLink.bind(md);
md.validateLink = (url) => parseNodeRef(url) !== null || validateLinkDefault(url);

/** A paragraph holding `children`. */
function paragraphTokens(children: Token[]): Token[] {
  const inline = new Token('inline', '', 0);
  inline.children = children;
  return [new Token('paragraph_open', 'p', 1), inline, new Token('paragraph_close', 'p', -1)];
}

/**
 * A cell's blocks. Most cells are one paragraph. In a cell whose lines start
 * with task markers (`CELL_TASK`, see `markCellTasks`), each run of marked
 * lines is a task list, the same task items a doc has anywhere else, and each
 * run of other lines a paragraph with its line breaks.
 */
function cellBlocks(inline: Token | undefined): Token[] {
  const children = inline?.children ?? [];
  if (!children.some((child) => child.type === CELL_TASK))
    return inline
      ? [new Token('paragraph_open', 'p', 1), inline, new Token('paragraph_close', 'p', -1)]
      : paragraphTokens([]);
  const lines: Token[][] = [[]];
  for (const child of children) {
    if (child.type === 'hardbreak') lines.push([]);
    else lines[lines.length - 1].push(child);
  }
  const out: Token[] = [];
  let plain: Token[] | null = null;
  let inList = false;
  for (const line of lines) {
    const task = line[0]?.type === CELL_TASK ? line[0] : null;
    if (!task) {
      if (inList) out.push(new Token('cell_task_list_close', 'ul', -1));
      inList = false;
      plain = plain ? [...plain, new Token('hardbreak', 'br', 0), ...line] : line;
      continue;
    }
    if (plain) out.push(...paragraphTokens(plain));
    plain = null;
    if (!inList) out.push(new Token('cell_task_list_open', 'ul', 1));
    inList = true;
    const item = new Token('cell_task_item_open', 'li', 1);
    item.meta = task.meta;
    out.push(item, ...paragraphTokens(line.slice(1)), new Token('cell_task_item_close', 'li', -1));
  }
  if (inList) out.push(new Token('cell_task_list_close', 'ul', -1));
  if (plain) out.push(...paragraphTokens(plain));
  return out;
}

/**
 * Adapt markdown-it's table token stream to the TipTap table schema:
 *   - drop `thead`/`tbody` wrappers (PM tables are just rows in a table)
 *   - give each cell block content (`cellBlocks`): PM cells hold blocks,
 *     markdown-it puts the inline token directly in the th/td
 */
function adaptTableTokens(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case 'thead_open':
      case 'thead_close':
      case 'tbody_open':
      case 'tbody_close':
        break;
      case 'th_open':
      case 'td_open': {
        const inline = tokens[i + 1]?.type === 'inline' ? tokens[i + 1] : undefined;
        out.push(t, ...cellBlocks(inline));
        if (inline) i += 1;
        break;
      }
      default:
        out.push(t);
    }
  }
  return out;
}

// A GFM table cell is one source line, so a line break inside it is written
// `<br>` (or `<br/>`, `<br />`). Raw HTML is off, so markdown-it hands it over
// as text; inside a cell it becomes a real hard break. Elsewhere it stays text.
const CELL_BREAK_RE = /<br\s*\/?>/i;

/** A cell's inline tokens with each `<br>` in its text turned into a break. */
function splitCellBreaks(children: Token[]): Token[] {
  // Adjacent text tokens first, so a `<br>` split across two still matches.
  const joined: Token[] = [];
  for (const child of children) {
    const last = joined[joined.length - 1];
    if (child.type === 'text' && last?.type === 'text') last.content += child.content;
    else joined.push(child);
  }
  return joined.flatMap((child) => {
    if (child.type !== 'text' || !CELL_BREAK_RE.test(child.content)) return [child];
    const out: Token[] = [];
    child.content.split(new RegExp(CELL_BREAK_RE.source, 'gi')).forEach((part, i) => {
      if (i > 0) out.push(new Token('hardbreak', 'br', 0));
      if (!part) return;
      const text = new Token('text', '', 0);
      text.content = part;
      out.push(text);
    });
    return out;
  });
}

/** Turn `<br>` into breaks in every table cell of a token stream. */
function readCellBreaks(tokens: Token[]): void {
  let inCell = false;
  for (const token of tokens) {
    if (token.type === 'th_open' || token.type === 'td_open') inCell = true;
    else if (token.type === 'th_close' || token.type === 'td_close') inCell = false;
    else if (inCell && token.type === 'inline' && token.children) {
      token.children = splitCellBreaks(token.children);
    }
  }
}

/** Parser env flag: split paragraphs at their soft line breaks. */
interface ParseEnv {
  splitSoftBreaks?: boolean;
}

/**
 * Split each paragraph at its soft line breaks (a single newline), so every
 * source line becomes its own paragraph. CommonMark joins those lines with a
 * space, which merges pasted plain-text lines into one. A break inside an
 * emphasis or link stays a space, so marks never straddle two paragraphs.
 */
function splitSoftBreakParagraphs(tokens: Token[]): Token[] {
  const out: Token[] = [];
  tokens.forEach((token, i) => {
    const open = tokens[i - 1];
    const close = tokens[i + 1];
    if (
      token.type !== 'inline' ||
      open?.type !== 'paragraph_open' ||
      close?.type !== 'paragraph_close' ||
      !token.children?.some((child) => child.type === 'softbreak')
    ) {
      out.push(token);
      return;
    }
    const lines: Token[][] = [[]];
    let depth = 0;
    for (const child of token.children) {
      if (child.type === 'softbreak' && depth === 0) {
        lines.push([]);
        continue;
      }
      depth += child.nesting;
      lines[lines.length - 1].push(child);
    }
    lines.forEach((children, n) => {
      if (n > 0) {
        const closeLine = new Token('paragraph_close', 'p', -1);
        const openLine = new Token('paragraph_open', 'p', 1);
        closeLine.hidden = openLine.hidden = open.hidden;
        out.push(closeLine, openLine);
      }
      const inline = new Token('inline', '', 0);
      inline.children = children;
      out.push(inline);
    });
  });
  return out;
}

// MarkdownParser only needs `.parse(src, env)` from its tokenizer; wrap
// the markdown-it instance so every parse flows through the table adapter.
const tokenizer = {
  parse: (src: string, env: Record<string, unknown> & ParseEnv) => {
    const tokens = md.parse(src, env);
    for (const token of tokens) {
      if (!token.children) continue;
      // Promote the whole link, not its text children: an unnamed reference
      // has no children, and formatted labels may have several.
      const children: Token[] = [];
      for (let i = 0; i < token.children.length; i++) {
        const child = token.children[i];
        const href = child.type === 'link_open' ? child.attrGet('href') : null;
        if (!href || !parseNodeRef(href)) {
          children.push(child);
          continue;
        }
        const chip = new Token('snaglet_chip', '', 0);
        // markdown-it percent-encodes a non-ASCII dash in a line range.
        chip.attrSet('href', canonicalNodeHref(href));
        let title = '';
        while (++i < token.children.length && token.children[i].type !== 'link_close') {
          title += token.children[i].content;
        }
        chip.content = title;
        children.push(chip);
      }
      token.children = children;
    }
    readCellBreaks(tokens);
    const adapted = adaptTableTokens(tokens);
    return env.splitSoftBreaks ? splitSoftBreakParagraphs(adapted) : adapted;
  },
} as MarkdownIt;

/**
 * The block tokens the rich editor's parser sees for `src`, with markdown-it's
 * source line maps. Doc line links use them to match source lines to the
 * editor's blocks (same tokenizer, so the block order lines up 1:1).
 */
export function richMarkdownBlockTokens(src: string): Token[] {
  const tokens = md.parse(src, {});
  readCellBreaks(tokens);
  return adaptTableTokens(tokens);
}

type DocJson = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocJson[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

function buildParser(schema: Schema): MarkdownParser {
  return new MarkdownParser(schema, tokenizer, {
    snaglet_chip: {
      node: 'chip',
      getAttrs: (token: Token) => {
        const href = token.attrGet('href') ?? '';
        return { href, title: token.content, include: false, kind: parseNodeRef(href)?.kind };
      },
    },
    paragraph: { block: 'paragraph' },
    blockquote: { block: 'blockquote' },
    heading: {
      block: 'heading',
      getAttrs: (tok: Token) => ({ level: Number(tok.tag.slice(1)) || 1 }),
    },
    bullet_list: { block: 'bulletList' },
    ordered_list: {
      block: 'orderedList',
      getAttrs: (tok: Token) => ({ start: Number(tok.attrGet('start') ?? 1) || 1 }),
    },
    list_item: { block: 'listItem' },
    code_block: { block: 'codeBlock', noCloseToken: true },
    fence: {
      block: 'codeBlock',
      getAttrs: (tok: Token) => ({ language: tok.info.trim() || null }),
      noCloseToken: true,
    },
    hr: { node: 'horizontalRule' },
    hardbreak: { node: 'hardBreak' },
    table: { block: 'table' },
    // A table cell's task lines (`cellBlocks`), which take their markers out.
    cell_task_list: { block: 'taskList' },
    [CELL_TASK]: { ignore: true, noCloseToken: true },
    cell_task_item: {
      block: 'taskItem',
      getAttrs: (tok: Token) => ({ checked: tok.meta?.checked === true }),
    },
    tr: { block: 'tableRow' },
    th: { block: 'tableHeader' },
    td: { block: 'tableCell' },
    // `![](doc-…)` is the chip include form; map every image token to a
    // chip. Non-node images are rare in workspace docs and still
    // round-trip as `![](src)` (alt text is dropped — the chip node has
    // no slot for it).
    image: {
      node: 'chip',
      getAttrs: (tok: Token) => {
        const href = tok.attrGet('src') ?? '';
        const ref = parseNodeRef(href);
        return { href, title: '', include: true, kind: ref?.kind ?? 'doc' };
      },
    },
    em: { mark: 'italic' },
    strong: { mark: 'bold' },
    s: { mark: 'strike' },
    code_inline: { mark: 'code', noCloseToken: true },
    link: {
      mark: 'link',
      getAttrs: (tok: Token) => ({ href: tok.attrGet('href') ?? '' }),
    },
  });
}

/** Optionally chips up bare ids in plain text (parity with `markdown.ts`'s
 *  `parseBareIds`). Node-ref links are already chips: the tokenizer promotes
 *  them before parsing, so any remaining link is an ordinary one. */
function chipifyInline(
  node: DocJson,
  { parseBareIds, parseBareTableIds }: BareIdOptions
): DocJson[] {
  if (node.type !== 'text' || !node.text) return [node];
  // Ids inside an ordinary link's text belong to that link.
  if (node.marks?.some((m) => m.type === 'link')) return [node];

  const hasCodeMark = node.marks?.some((m) => m.type === 'code') ?? false;
  if (!parseBareIds || hasCodeMark) return [node];

  const out: DocJson[] = [];
  let cursor = 0;
  const bareRe = parseBareTableIds ? ID_ONLY_BARE_RE : BARE_ID_RE;
  bareRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = bareRe.exec(node.text))) {
    const match = m[0];
    const href = tableChipHrefForBareId(match) ?? match;
    const ref = parseNodeRef(href);
    if (!ref) continue;
    if (m.index > cursor) out.push({ ...node, text: node.text.slice(cursor, m.index) });
    out.push({ type: 'chip', attrs: { href, title: '', include: false, kind: ref.kind } });
    cursor = m.index + match.length;
  }
  if (out.length === 0) return [node];
  if (cursor < node.text.length) out.push({ ...node, text: node.text.slice(cursor) });
  return out;
}

/** GFM task items parse as plain list items starting with `[ ] ` / `[x] `.
 *  A bullet list where every item has the marker becomes a taskList; mixed
 *  lists stay literal. */
function taskifyList(node: DocJson): DocJson {
  if (node.type !== 'bulletList' || !node.content?.length) return node;

  const markers: Array<boolean | null> = node.content.map((item) => {
    const para = item.content?.[0];
    const first = para?.type === 'paragraph' ? para.content?.[0] : undefined;
    if (first?.type !== 'text' || !first.text || first.marks?.length) return null;
    const m = TASK_MARKER_RE.exec(first.text);
    return m ? m[1] !== ' ' : null;
  });
  if (markers.some((m) => m === null)) return node;

  return {
    type: 'taskList',
    content: node.content.map((item, i) => {
      const [para, ...rest] = item.content ?? [];
      const [first, ...inline] = para.content ?? [];
      const stripped = (first.text ?? '').replace(TASK_MARKER_RE, '');
      const content = stripped.length > 0 ? [{ ...first, text: stripped }, ...inline] : inline;
      return {
        type: 'taskItem',
        attrs: { checked: markers[i] === true },
        content: [{ ...para, content }, ...rest],
      };
    }),
  };
}

function transformParsed(node: DocJson, bareIds: BareIdOptions): DocJson {
  const withTasks = taskifyList(node);
  if (!withTasks.content) return withTasks;
  const isCode = withTasks.type === 'codeBlock';
  const content = withTasks.content
    .map((child) => transformParsed(child, bareIds))
    .flatMap((child) => (isCode ? [child] : chipifyInline(child, bareIds)));
  return { ...withTasks, content };
}

const parserCache = new WeakMap<Schema, MarkdownParser>();

export function richMarkdownToDoc(
  markdown: string,
  schema: Schema,
  options: { parseBareIds?: boolean; parseBareTableIds?: boolean; keepLines?: boolean } = {}
): PMNode {
  // A whole .mermaid file is source, not CommonMark: parsing it as prose
  // collapses soft breaks and treats four-space indentation as separate code.
  if (schema.nodes.codeBlock && isMermaidBlock(null, markdown)) {
    return schema.nodes.doc.create(
      null,
      schema.nodes.codeBlock.create(
        { language: 'mermaid' },
        schema.text(markdown.replace(/\r\n?/g, '\n'))
      )
    );
  }
  let parser = parserCache.get(schema);
  if (!parser) {
    parser = buildParser(schema);
    parserCache.set(schema, parser);
  }
  const env: ParseEnv = { splitSoftBreaks: options.keepLines === true };
  const parsed = parser.parse(
    agentMentionsToMarkdownLinksWithAgents(markdown, getAgentsCached()),
    env
  );
  const json = transformParsed(parsed.toJSON() as DocJson, {
    parseBareIds: options.parseBareIds === true,
    parseBareTableIds: options.parseBareIds === true && options.parseBareTableIds === true,
  });
  return schema.nodeFromJSON(json);
}

/**
 * Parse pasted plain text as markdown so it lands as real blocks. `plain`
 * (Shift+Cmd+V) skips the parse and inserts one paragraph per line, like
 * ProseMirror's default.
 */
export function pastedTextToSlice(text: string, schema: Schema, plain: boolean): Slice {
  if (plain) {
    const paragraphs = text
      .split(/\r\n?|\n/)
      .map((line) =>
        schema.nodes.paragraph.create(null, line.length > 0 ? [schema.text(line)] : undefined)
      );
    return Slice.maxOpen(Fragment.from(paragraphs));
  }
  // Pasted text keeps its lines: a single newline is a new paragraph here,
  // not the space CommonMark would join the lines with.
  const doc = richMarkdownToDoc(text, schema, { parseBareIds: true, keepLines: true });
  return isMermaidBlock(null, text) ? new Slice(doc.content, 0, 0) : Slice.maxOpen(doc.content);
}

/**
 * Re-render markdown stored as escaped literal text (`\## heading`): serialize
 * the doc, strip CommonMark backslash-escapes and re-parse. Rich blocks
 * round-trip unchanged. Exposed as the `/markdown` slash command.
 */
export function rerenderLiteralMarkdown(editor: Editor): void {
  const markdown = docToRichMarkdown(editor);
  const unescaped = markdown.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
  const doc = richMarkdownToDoc(unescaped, editor.state.schema, { parseBareIds: true });
  // emitUpdate so the host's onChange fires and the recovery persists.
  editor.commands.setContent(doc, { emitUpdate: true });
}

const d = defaultMarkdownSerializer;

function buildSerializer(passIdOnly: boolean): MarkdownSerializer {
  return new MarkdownSerializer(
    {
      paragraph: d.nodes.paragraph,
      heading: d.nodes.heading,
      blockquote: d.nodes.blockquote,
      horizontalRule: (state, node) => {
        state.write(String(node.attrs.markup ?? '---'));
        state.closeBlock(node);
      },
      codeBlock: (state, node) => {
        state.write('```' + String(node.attrs.language ?? '') + '\n');
        state.text(node.textContent, false);
        state.ensureNewLine();
        state.write('```');
        state.closeBlock(node);
      },
      bulletList: (state, node) => {
        state.renderList(node, '  ', () => '- ');
      },
      orderedList: (state, node) => {
        const start = Number(node.attrs.start ?? 1) || 1;
        const maxW = String(start + node.childCount - 1).length;
        const space = ' '.repeat(maxW + 2);
        state.renderList(node, space, (i) => {
          const nStr = String(start + i);
          return ' '.repeat(maxW - nStr.length) + nStr + '. ';
        });
      },
      listItem: d.nodes.list_item,
      taskList: (state, node) => {
        state.renderList(node, '  ', () => '- ');
      },
      taskItem: (state, node) => {
        state.write(node.attrs.checked === true ? '[x] ' : '[ ] ');
        state.renderContent(node);
      },
      // A break inside a table cell must stay on the row's one line.
      hardBreak: (state, node, parent, index) => {
        if ((state as CellSerializerState).inTableCell) state.write(CELL_BREAK);
        else d.nodes.hard_break(state, node, parent, index);
      },
      text: d.nodes.text,
      // GFM pipe table. A cell is one source line: its lines (hard breaks,
      // extra paragraphs, list items) are joined with `<br>`, which reads
      // back as hard breaks. While inside the table, every literal `|` must
      // be backslash-escaped or it reads as a column break on reload, and
      // the table reads `\|` back as `|`, inside code spans too. `esc()`
      // applies `options.escapeExtraCharacters`, so a pipe-escaper is swapped
      // in for the duration; text written unescaped (a code span, a link's
      // address) has its pipes escaped on the way through `state.text`.
      table: (state, node) => {
        const options = state.options as { escapeExtraCharacters?: RegExp };
        const cellState = state as CellSerializerState;
        const prevEscape = options.escapeExtraCharacters;
        const writeText = state.text;
        options.escapeExtraCharacters = /\|/g;
        state.text = (text, escape = true) =>
          writeText.call(state, escape ? text : text.replace(/\|/g, '\\|'), escape);
        cellState.inTableCell = true;
        node.forEach((row, _rowOffset, rowIndex) => {
          state.write('| ');
          row.forEach((cell, _cellOffset, cellIndex) => {
            if (cellIndex > 0) state.write(' | ');
            writeCellLines(state, cell, { first: true });
          });
          state.write(' |');
          state.ensureNewLine();
          if (rowIndex === 0) {
            state.write(`|${' --- |'.repeat(row.childCount)}`);
            state.ensureNewLine();
          }
        });
        cellState.inTableCell = false;
        options.escapeExtraCharacters = prevEscape;
        state.text = writeText;
        state.closeBlock(node);
      },
      // Rows/cells are rendered inline by the `table` handler above;
      // these exist so a stray node outside a table can't crash the
      // serializer.
      tableRow: (state, node) => {
        state.renderContent(node);
      },
      tableCell: (state, node) => {
        state.renderContent(node);
      },
      tableHeader: (state, node) => {
        state.renderContent(node);
      },
      chip: (state, node) => {
        const href = canonicalNodeHref(String(node.attrs.href ?? ''));
        const title = String(node.attrs.title ?? '');
        const include = node.attrs.include === true;
        const kind = String(node.attrs.kind ?? '');
        if (passIdOnly) {
          state.write(idOnlyChipValue(href));
        } else if (!include && kind === 'agent') {
          state.write(agentMentionMarkdown(title));
        } else {
          state.write(include ? `![](${href})` : `[${escapeChipTitle(title)}](${href})`);
        }
      },
    },
    {
      italic: d.marks.em,
      bold: d.marks.strong,
      code: d.marks.code,
      link: d.marks.link,
      strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    }
  );
}

const CELL_BREAK = '<br>';

/** Serializer state while a table is written (see the `table` handler). */
type CellSerializerState = MarkdownSerializerState & { inTableCell?: boolean };

/** The marker a list item gets when a cell flattens it onto one line. */
function cellItemMarker(list: PMNode, index: number, item: PMNode): string {
  if (list.type.name === 'orderedList') return `${(Number(list.attrs.start) || 1) + index}. `;
  if (list.type.name === 'taskList') return item.attrs.checked === true ? '[x] ' : '[ ] ';
  return '• ';
}

/**
 * Write a table cell's blocks on its one line, each line after the first
 * preceded by `<br>`. Paragraphs and headings write inline; list items get a
 * text marker (`• `, `1. `), since GFM cells hold no blocks, and task items
 * their `[ ]` / `[x]`, which reads back as task items (`cellBlocks`); a
 * code block writes each of its lines. An empty item writes its marker alone.
 */
function writeCellLines(
  state: MarkdownSerializerState,
  node: PMNode,
  line: { first: boolean },
  marker = ''
): void {
  node.forEach((block, _offset, index) => {
    if (block.isTextblock) {
      if (!line.first) state.write(CELL_BREAK);
      line.first = false;
      if (index === 0 && marker) state.write(block.content.size > 0 ? marker : marker.trimEnd());
      if (!block.type.spec.code) {
        state.renderInline(block);
        return;
      }
      block.textContent.split('\n').forEach((codeLine, n) => {
        if (n > 0) state.write(CELL_BREAK);
        state.text(codeLine, true);
      });
      return;
    }
    if (['bulletList', 'orderedList', 'taskList'].includes(block.type.name)) {
      block.forEach((item, _itemOffset, itemIndex) => {
        writeCellLines(state, item, line, cellItemMarker(block, itemIndex, item));
      });
      return;
    }
    writeCellLines(state, block, line, index === 0 ? marker : '');
  });
}

const serializers = {
  href: buildSerializer(false),
  idOnly: buildSerializer(true),
};

export function docToRichMarkdown(editor: Editor, options: { passIdOnly?: boolean } = {}): string {
  const serializer = options.passIdOnly === true ? serializers.idOnly : serializers.href;
  return serializer.serialize(editor.state.doc, { tightLists: true });
}

/** One block's markdown, written as it would be in a doc holding only that block. */
export function blockToRichMarkdown(block: PMNode): string {
  const doc = block.type.schema.topNodeType.create(null, block);
  return serializers.href.serialize(doc, { tightLists: true });
}
