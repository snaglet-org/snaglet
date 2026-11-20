import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MERMAID_CHIP_MARK, extractMermaidChips, mermaidChipSlot } from './mermaidChips';
import { mermaidLabelKey } from './mermaidRender';

// The agent roster and table catalog that agent-id and row-by-name links
// resolve through; null is a lookup that has not loaded.
const lookups = vi.hoisted(() => ({
  agents: null as Array<{ id: string; name: string }> | null,
  tables: null as Array<{ id: string; name: string }> | null,
}));
vi.mock('@desktop/features/rich-markdown/editor/agentMentionCache', () => ({
  getAgentsCached: () => lookups.agents,
}));
vi.mock('@desktop/features/database/tableNameCache', () => ({
  getCachedTableByName: (name: string) =>
    lookups.tables?.find((table) => table.name.toLowerCase() === name.toLowerCase()) ?? null,
}));

const DOC = 'doc-1111111111111-aaaaaaaaa';
const THREAD = 'thread-1111111111111-bbbbbbbbb';
const CONTAINER = 'container-1111111111111-ccccccccc';
const TABLE = 'table-1111111111111-aaaaaaaaa';
const ENTRY_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENTRY = `${TABLE}/${ENTRY_ID}`;
const AGENT = 'test-agent-a';
const NO_LOOKUPS = { agents: false, tableNames: false };

beforeEach(() => {
  lookups.agents = null;
  lookups.tables = null;
});

/** The marker the n-th chip (0-based) carries after its placeholder text. */
function mark(index: number): string {
  const bits = index.toString(2).replace(/0/g, '\u200b').replace(/1/g, '\u200c');
  return `${MERMAID_CHIP_MARK}${bits}${MERMAID_CHIP_MARK}`;
}

/** The n-th chip's placeholder for `text`, as {@link unpad} leaves it. */
function placeholder(text: string, index: number): string {
  return `${text}${mark(index)}`;
}

/**
 * Drop the guarded spaces that pad placeholders (`⁠ ⁠ ⁠`, or a lone `⁠` with
 * no room for spaces) on both sides of the text, keeping the marker.
 */
function unpad(text: string): string {
  return text.replace(/(^|")⁠(?: ⁠)*/g, '$1').replace(/⁠(?: ⁠)*(⁠[\u200b\u200c]+⁠)/g, '$1');
}

/** How many guarded spaces pad the front of a placeholder. */
function leadingPad(label = ''): number {
  return (/^⁠((?: ⁠)*)/.exec(label)?.[1]?.length ?? 0) / 2;
}

describe('extractMermaidChips', () => {
  it.each([
    ['[', ']'],
    ['[[', ']]'],
    ['[(', ')]'],
    ['([', '])'],
    ['[/', '/]'],
    ['[\\', '\\]'],
    ['[/', '\\]'],
    ['(', ')'],
    ['((', '))'],
    ['(((', ')))'],
    ['{', '}'],
    ['{{', '}}'],
    ['>', ']'],
  ])('rewrites a bare id in a %s…%s label, keeping the shape', (open, close) => {
    const { source, chips } = extractMermaidChips(`graph TD\n  A${open}${DOC}${close} --> B`);
    const label = placeholder(DOC, 0);
    expect(unpad(source)).toBe(`graph TD\n  A${open}"${label}"${close} --> B`);
    expect(chips.map((chip) => ({ ...chip, label: unpad(chip.label) }))).toEqual([
      { label, href: DOC, kind: 'doc', nodeId: DOC, title: DOC, form: 'id' },
    ]);
  });

  it('accepts a quoted bare id and a quoted or unquoted markdown link', () => {
    const { source, chips } = extractMermaidChips(
      [
        'flowchart LR',
        `  A["${DOC}"] --> B("[Spec](${THREAD})")`,
        `  B --> C[[Plan](${CONTAINER})]`,
      ].join('\n')
    );
    expect(unpad(source)).toBe(
      [
        'flowchart LR',
        `  A["${placeholder(DOC, 0)}"] --> B("${placeholder('Spec', 1)}")`,
        `  B --> C["${placeholder('Plan', 2)}"]`,
      ].join('\n')
    );
    expect(chips.map(({ kind, nodeId, title, form }) => ({ kind, nodeId, title, form }))).toEqual([
      { kind: 'doc', nodeId: DOC, title: DOC, form: 'id' },
      { kind: 'thread', nodeId: THREAD, title: 'Spec', form: 'link' },
      { kind: 'container', nodeId: CONTAINER, title: 'Plan', form: 'link' },
    ]);
  });

  it('rewrites a whole one-line diagram', () => {
    const { source, chips } = extractMermaidChips(`graph TD; A[${DOC}] --> B[Next]`);
    expect(unpad(source)).toBe(`graph TD; A["${placeholder(DOC, 0)}"] --> B[Next]`);
    expect(chips).toHaveLength(1);
  });

  it('keeps line and heading anchors on the chip', () => {
    const { source, chips } = extractMermaidChips(
      `graph TD\n  A[${DOC}#L12-L20] --> B["[Limits](${DOC}#h=rate-limits)"]`
    );
    expect(chips[0]).toMatchObject({
      href: `${DOC}#L12-L20`,
      nodeId: DOC,
      anchor: { lines: { startLine: 12, endLine: 20 } },
      title: DOC,
    });
    expect(chips[1]).toMatchObject({
      href: `${DOC}#h=rate-limits`,
      anchor: { heading: { slug: 'rate-limits' } },
      title: 'Limits',
    });
    // The anchor never reaches Mermaid: `#` would read as an entity code.
    expect(unpad(source)).toBe(
      `graph TD\n  A["${placeholder(DOC, 0)}"] --> B["${placeholder('Limits', 1)}"]`
    );
  });

  it('sizes a bare id by its resolved title, and falls back to the id', () => {
    const titles = (ref: { id: string }) => (ref.id === DOC ? 'Release plan' : null);
    const { source, chips } = extractMermaidChips(`graph TD\n  A[${DOC}] --> B[${THREAD}]`, titles);
    expect(unpad(source)).toBe(
      `graph TD\n  A["${placeholder('Release plan', 0)}"] --> B["${placeholder(THREAD, 1)}"]`
    );
    expect(chips.map((chip) => chip.title)).toEqual(['Release plan', THREAD]);
  });

  it('pads a placeholder with guarded spaces so the node fits its chip', () => {
    const { chips } = extractMermaidChips(
      [
        'graph TD',
        `  A["[Spec](${DOC})"] --> B["[Spec](${DOC}#L12-L20)"]`,
        `  B --> C["[Drag target resolution](${THREAD})"]`,
        `  C --> D["[Fill in little list it](${THREAD})"]`,
      ].join('\n')
    );
    const [short, anchored, wide, narrow] = chips.map((chip) => chip.label);
    expect(short).toBe(`⁠ ⁠ ⁠Spec⁠ ⁠ ⁠${mark(0)}`);
    // The anchor label widens the chip; narrow letters draw a narrower node.
    expect(leadingPad(anchored)).toBeGreaterThan(leadingPad(short));
    expect(leadingPad(wide)).toBeGreaterThan(1);
    expect(leadingPad(narrow)).toBeGreaterThan(leadingPad(wide));
  });

  it('strips characters that could break Mermaid from the placeholder, never from the title', () => {
    const { source, chips } = extractMermaidChips(
      `graph TD\n  A[[Say "hi" #quot; (x) {y} <b>; ok?](${DOC})]`
    );
    expect(unpad(source)).toBe(`graph TD\n  A["${placeholder('Say hi quot x y b ok?', 0)}"]`);
    expect(chips[0]?.title).toBe('Say "hi" #quot; (x) {y} <b>; ok?');
  });

  it('keeps letters from any script and falls back to the id when nothing is left', () => {
    const { source } = extractMermaidChips(
      `graph TD\n  A["[Café 計画](${DOC})"] --> B[[#;](${THREAD})]`
    );
    expect(unpad(source)).toBe(
      `graph TD\n  A["${placeholder('Café 計画', 0)}"] --> B["${placeholder(THREAD, 1)}"]`
    );
  });

  it.each([
    ['a ref as the node id', `graph TD\n  ${DOC} --> B[Next]`],
    ['an edge label', `graph TD\n  A -->|${DOC}| B`],
    ['edge text', `graph TD\n  A -- ${DOC} --> B`],
    ['a ref embedded in a longer label', `graph TD\n  A[Plan ${DOC} here] --> B`],
    ['an embedded markdown link', `graph TD\n  A["See [Spec](${DOC}) first"] --> B`],
    ['a subgraph title', `graph TD\n  subgraph S1 [${DOC}]\n    A --> B\n  end`],
    ['a quoted subgraph title', `graph TD\n  subgraph S1["${DOC}"]\n    A --> B\n  end`],
    ['a click target', `graph TD\n  A --> B\n  click A "${DOC}"`],
    ['a comment', `graph TD\n  %% A[${DOC}]\n  A --> B`],
    ['an image id', 'graph TD\n  A[image-1111111111111-ddddddddd] --> B'],
    ['an image link', 'graph TD\n  A["[Picture](image-1111111111111-ddddddddd)"] --> B'],
    ['a model link', 'graph TD\n  A["[Model](model:test-model)"] --> B'],
    ['a run link', `graph TD\n  A["[Run](run:${ENTRY_ID})"] --> B`],
    ['a file link', 'graph TD\n  A["[Notes](file:/tmp/notes.md)"] --> B'],
    ['a bare table catalog id', `graph TD\n  A[${TABLE}] --> B`],
    ['a bare table link href', `graph TD\n  A[table:${TABLE}] --> B`],
    ['a bare entry href', `graph TD\n  A[entry:${ENTRY}] --> B`],
    [
      'a table link embedded in a longer label',
      `graph TD\n  A["See [List](table:${TABLE})"] --> B`,
    ],
    ['an agent link with a malformed id', 'graph TD\n  A["[Agent](agent:Not An Id)"] --> B'],
    ['an unknown kind', 'graph TD\n  A[note-1111111111111-eeeeeeeee] --> B'],
    ['a malformed id', 'graph TD\n  A[doc-abc] --> B[doc-123]'],
    ['a plain web link', 'graph TD\n  A["[Site](https://example.com)"] --> B'],
    ['a sequence diagram', `sequenceDiagram\n  A->>B: ${DOC}\n  A[${DOC}]`],
    ['no refs at all', 'graph TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]'],
  ])('leaves %s byte-identical', (_case, input) => {
    const result = extractMermaidChips(input);
    expect(result.source).toBe(input);
    expect(result.chips).toEqual([]);
  });

  it('skips front matter before the declaration', () => {
    const input = `---\ntitle: A[${DOC}]\n---\nflowchart TD\n  A[${DOC}]`;
    const { source } = extractMermaidChips(input);
    expect(unpad(source)).toBe(
      `---\ntitle: A[${DOC}]\n---\nflowchart TD\n  A["${placeholder(DOC, 0)}"]`
    );
  });

  it('keeps everything around a chip label, including line endings', () => {
    const input = `%%{init: {"theme": "neutral"}}%%\r\ngraph TD\r\n  A[${DOC}]:::hot & B[Two] --> C\r\n`;
    const { source } = extractMermaidChips(input);
    expect(unpad(source)).toBe(
      `%%{init: {"theme": "neutral"}}%%\r\ngraph TD\r\n  A["${placeholder(DOC, 0)}"]:::hot & B[Two] --> C\r\n`
    );
  });

  it('gives every chip a distinct label, even with the same text', () => {
    const { chips } = extractMermaidChips(
      `graph TD\n  A["[Spec](${DOC})"] --> B["[Spec](${THREAD})"]`
    );
    expect(chips[0]?.label).not.toBe(chips[1]?.label);
    expect(mermaidLabelKey(chips[0]?.label ?? '')).not.toBe(mermaidLabelKey(chips[1]?.label ?? ''));
  });

  it('returns no lookups for a chart whose links all resolved', () => {
    expect(extractMermaidChips(`graph TD\n  A["[Spec](${DOC})"]`).lookups).toEqual(NO_LOOKUPS);
    expect(extractMermaidChips(`sequenceDiagram\n  A->>B: [Bob](${AGENT})`).lookups).toEqual(
      NO_LOOKUPS
    );
  });
});

describe('extractMermaidChips: chip sizing', () => {
  // Measured in Chromium and WebKit with Mermaid 12's default (neo) look and
  // Snaglet's config: each title's text in a 16px Arial label, the chip showing it
  // (14px IBM Plex Mono with its dot, padding and border), and a cylinder, the
  // shape that keeps the least room beside its label, drawn 24px wider than
  // the label, which Mermaid lays out at least 120px wide.
  const MEASURED: Record<string, { text: number; chip: number }> = {
    'Release plan': { text: 87.6, chip: 120.5 },
    'Tech research': { text: 100.2, chip: 129 },
    github_repo_watch: { text: 135.1, chip: 163.2 },
    work_loop_template: { text: 143.1, chip: 171.7 },
    'illicit little list fill': { text: 106.8, chip: 223 },
    a_b_c_d_e_f_g_h_i_j_k_l_: { text: 191.2, chip: 223 },
    'Quarterly planning review': { text: 181.3, chip: 231.5 },
    'Quarterly planning reviews 2026!': { text: 233.8, chip: 291.3 },
  };
  const SPACE_PX = 4.448;
  const CYLINDER_PX = 24;
  const MIN_LABEL_PX = 120;
  const LABEL_WRAP_PX = 240;

  function measured(title: string) {
    const found = MEASURED[title];
    if (!found) throw new Error(`no measured width for ${title}`);
    return found;
  }

  /** A cylinder node holding a table chip titled `title`, as Mermaid draws it. */
  function cylinder(title: string) {
    const { chips } = extractMermaidChips(`flowchart LR\n  T1[("[${title}](table:${TABLE})")]`);
    const text = measured(title).text + 2 * leadingPad(chips[0]?.label) * SPACE_PX;
    const box = { x: 0, y: 0, width: Math.max(text, MIN_LABEL_PX) + CYLINDER_PX, height: 87 };
    return { text, slot: mermaidChipSlot({ box, labelWidth: text }) };
  }

  it('widens a cylinder until its label holds a 17-character underscore title', () => {
    const { text, slot } = cylinder('github_repo_watch');
    expect(text).toBeGreaterThanOrEqual(measured('github_repo_watch').chip);
    expect(slot.width).toBeGreaterThanOrEqual(measured('github_repo_watch').chip);
  });

  it.each(Object.keys(MEASURED).filter((title) => title.length <= 25))(
    'keeps the chip titled %s whole on a one-line cylinder label',
    (title) => {
      const { text, slot } = cylinder(title);
      expect(slot.width).toBeGreaterThanOrEqual(measured(title).chip);
      expect(text).toBeLessThanOrEqual(LABEL_WRAP_PX);
    }
  );

  it('stops padding at the label wrap, so the padding never wraps a label', () => {
    // A label within a guarded space of the wrap gets none, so it stays one row.
    const near = cylinder('Quarterly planning reviews 2026!');
    expect(near.text).toBe(measured('Quarterly planning reviews 2026!').text);
    expect(near.text).toBeLessThanOrEqual(LABEL_WRAP_PX);
    const { chips } = extractMermaidChips(
      `flowchart LR\n  T1[("[this_is_a_very_long_table_name_that_goes_on](table:${TABLE})")]`
    );
    expect(leadingPad(chips[0]?.label)).toBe(0);
  });

  it('pads an ASCII label right up to the wrap, so a 27-character bare id stays whole', () => {
    // Measured: the id's text is 224.1px and its chip 248.6px. One guarded
    // space a side (233px) still fits under the wrap, and the slot holds the chip.
    const { chips } = extractMermaidChips(`flowchart LR\n  A[(doc-2222222222222-ccccccccc)]`);
    expect(leadingPad(chips[0]?.label)).toBe(1);
    const text = 224.1 + 2 * SPACE_PX;
    expect(text).toBeLessThanOrEqual(LABEL_WRAP_PX);
    const box = { x: 0, y: 0, width: text + CYLINDER_PX, height: 87 };
    expect(mermaidChipSlot({ box, labelWidth: text }).width).toBeGreaterThanOrEqual(248.6);
  });

  it('gives combining marks no width, in the label or the chip', () => {
    const pad = (title: string) =>
      leadingPad(extractMermaidChips(`flowchart LR\n  A["[${title}](${DOC})"]`).chips[0]?.label);
    expect(pad('Re\u0301sume\u0301 draft')).toBe(pad('R\u00e9sum\u00e9 draft'));
    expect(pad('R\u00e9sum\u00e9 draft')).toBe(pad('Resume draft'));
  });
});

describe('mermaidChipSlot', () => {
  it("centers the slot on the node's box, as wide as the label plus 8px a side", () => {
    const box = { x: 10, y: 20, width: 200, height: 40 };
    expect(mermaidChipSlot({ box, labelWidth: 150 })).toEqual({
      x: 27,
      y: 20,
      width: 166,
      height: 40,
    });
  });

  it('never reaches past the node, so a truncated chip stays inside its outline', () => {
    const box = { x: 10, y: 20, width: 160, height: 40 };
    expect(mermaidChipSlot({ box, labelWidth: 150 })).toEqual(box);
  });

  it("gives a short label Mermaid's 120px minimum, so a longer live name keeps that room", () => {
    // `[Row](entry:…)` sizes a 152px rectangle around a 54px label; the chip
    // shows the row's live name.
    const box = { x: 0, y: 0, width: 152, height: 41 };
    expect(mermaidChipSlot({ box, labelWidth: 54 })).toEqual({
      x: 8,
      y: 0,
      width: 136,
      height: 41,
    });
  });

  it('sizes a two-row label by its wider row', () => {
    // A 43-character title wraps in a 257.9px cylinder; its wider row is 233.8px.
    const slot = mermaidChipSlot({
      box: { x: 0, y: 0, width: 257.9, height: 109.5 },
      labelWidth: 233.8,
    });
    expect(slot.width).toBeCloseTo(249.8, 1);
    expect(slot.x).toBeCloseTo(4.05, 2);
  });

  it('still covers a label drawn off-center in its box', () => {
    // A flag draws its label 5.15px right of its box's center (measured), so
    // the slot, centered on the box, must still span the whole label.
    const box = { x: 0, y: 0, width: 223.1, height: 41.4 };
    const label = { width: 170.7, left: (223.1 - 170.7) / 2 + 5.15 };
    const slot = mermaidChipSlot({ box, labelWidth: label.width });
    expect(slot.x).toBeLessThanOrEqual(label.left);
    expect(slot.x + slot.width).toBeGreaterThanOrEqual(label.left + label.width);
  });
});

describe('extractMermaidChips: tables, rows and agents', () => {
  const summary = (source: string) =>
    extractMermaidChips(source).chips.map(({ href, kind, nodeId, title, form }) => ({
      href,
      kind,
      nodeId,
      title,
      form,
    }));

  it('chips a table link, quoted or not, as a table chip', () => {
    const {
      source,
      chips,
      lookups: waits,
    } = extractMermaidChips(
      `graph TD\n  A["[Reading list](table:${TABLE})"] --> B[[Backlog](table:${TABLE})]`
    );
    expect(unpad(source)).toBe(
      `graph TD\n  A["${placeholder('Reading list', 0)}"] --> B["${placeholder('Backlog', 1)}"]`
    );
    expect(chips.map(({ href, kind, nodeId, form }) => ({ href, kind, nodeId, form }))).toEqual([
      { href: `table:${TABLE}`, kind: 'table', nodeId: TABLE, form: 'link' },
      { href: `table:${TABLE}`, kind: 'table', nodeId: TABLE, form: 'link' },
    ]);
    expect(waits).toEqual(NO_LOOKUPS);
  });

  it('chips a built-in table link too', () => {
    expect(summary('graph TD\n  A["[Automations](table:table-builtin-automations)"]')).toEqual([
      {
        href: 'table:table-builtin-automations',
        kind: 'table',
        nodeId: 'table-builtin-automations',
        title: 'Automations',
        form: 'link',
      },
    ]);
  });

  it('chips a tool link by its slug id, and leaves bare `tool:` text plain', () => {
    expect(summary('graph TD\n  A["[Weather](tool:weather_today)"] --> B[tool:create]')).toEqual([
      {
        href: 'tool:weather_today',
        kind: 'tool',
        nodeId: 'weather_today',
        title: 'Weather',
        form: 'link',
      },
    ]);
  });

  it('chips a row link as an entry chip', () => {
    expect(summary(`graph TD\n  A["[Fix login](entry:${ENTRY})"] --> B`)).toEqual([
      { href: `entry:${ENTRY}`, kind: 'entry', nodeId: ENTRY, title: 'Fix login', form: 'link' },
    ]);
  });

  it('chips a row by table name once the catalog knows the name, and waits on it before', () => {
    const chart = `graph TD\n  A["[Fix login](test_backlog:${ENTRY_ID})"] --> B`;
    const before = extractMermaidChips(chart);
    expect(before.source).toBe(chart);
    expect(before.chips).toEqual([]);
    expect(before.lookups).toEqual({ agents: false, tableNames: true });

    lookups.tables = [{ id: TABLE, name: 'test_backlog' }];
    const after = extractMermaidChips(chart);
    expect(unpad(after.source)).toBe(`graph TD\n  A["${placeholder('Fix login', 0)}"] --> B`);
    expect(after.chips).toMatchObject([
      { href: `test_backlog:${ENTRY_ID}`, kind: 'entry', nodeId: ENTRY, title: 'Fix login' },
    ]);
    expect(after.lookups).toEqual(NO_LOOKUPS);
  });

  it('matches a row by table name whatever the case of the name', () => {
    lookups.tables = [{ id: TABLE, name: 'test_backlog' }];
    expect(summary(`graph TD\n  A["[Fix login](Test_Backlog:${ENTRY_ID})"] --> B`)).toEqual([
      {
        href: `Test_Backlog:${ENTRY_ID}`,
        kind: 'entry',
        nodeId: ENTRY,
        title: 'Fix login',
        form: 'link',
      },
    ]);
  });

  it('chips a mixed-case kind scheme, as prose does', () => {
    expect(summary(`graph TD\n  A["[Spec](Page:${ENTRY_ID})"] --> B`)).toEqual([
      { href: `Page:${ENTRY_ID}`, kind: 'page', nodeId: ENTRY_ID, title: 'Spec', form: 'link' },
    ]);
  });

  it('leaves a row by an unknown table name plain once the catalog has loaded', () => {
    lookups.tables = [{ id: TABLE, name: 'test_backlog' }];
    const chart = `graph TD\n  A["[Fix login](other_table:${ENTRY_ID})"] --> B`;
    const result = extractMermaidChips(chart);
    expect(result.source).toBe(chart);
    expect(result.chips).toEqual([]);
  });

  it('chips an agent:<agent id> link without the roster', () => {
    const {
      source,
      chips,
      lookups: waits,
    } = extractMermaidChips(
      `graph TD\n  A["[Test Agent A](agent:${AGENT})"] --> B[[Agent](agent:doc-writer)]`
    );
    expect(unpad(source)).toBe(
      `graph TD\n  A["${placeholder('Test Agent A', 0)}"] --> B["${placeholder('Agent', 1)}"]`
    );
    expect(chips.map(({ href, kind, nodeId, title }) => ({ href, kind, nodeId, title }))).toEqual([
      { href: `agent:${AGENT}`, kind: 'agent', nodeId: AGENT, title: 'Test Agent A' },
      // A slug that starts like a kind prefix still names the agent.
      { href: 'agent:doc-writer', kind: 'agent', nodeId: 'doc-writer', title: 'Agent' },
    ]);
    expect(waits).toEqual(NO_LOOKUPS);
  });

  it('chips a link to a bare agent id once the roster knows it, and waits on it before', () => {
    const chart = `graph TD\n  A["[Test Agent A](${AGENT})"] --> B[[Agent](${AGENT})]`;
    const before = extractMermaidChips(chart);
    expect(before.source).toBe(chart);
    expect(before.lookups).toEqual({ agents: true, tableNames: false });

    lookups.agents = [{ id: AGENT, name: 'Test Agent A' }];
    const after = extractMermaidChips(chart);
    expect(unpad(after.source)).toBe(
      `graph TD\n  A["${placeholder('Test Agent A', 0)}"] --> B["${placeholder('Agent', 1)}"]`
    );
    expect(after.chips).toMatchObject([
      { href: AGENT, kind: 'agent', nodeId: AGENT, title: 'Test Agent A', form: 'link' },
      { href: AGENT, kind: 'agent', nodeId: AGENT, title: 'Agent', form: 'link' },
    ]);
    expect(after.lookups).toEqual(NO_LOOKUPS);
  });

  it.each([
    ['a bare agent id', `graph TD\n  A[${AGENT}] --> B`],
    ['a quoted bare agent id', `graph TD\n  A["${AGENT}"] --> B`],
    ['a bare agent:<agent id>', `graph TD\n  A[agent:${AGENT}] --> B`],
    [
      'an agent link in a longer label',
      `graph TD\n  A["Ask [Test Agent A](${AGENT}) first"] --> B`,
    ],
    ['an agent id as an edge label', `graph TD\n  A -->|${AGENT}| B`],
    ['a link to an id no agent has', 'graph TD\n  A["[Someone](someone-else)"] --> B'],
  ])('leaves %s plain even with the roster loaded', (_case, chart) => {
    lookups.agents = [{ id: AGENT, name: 'Test Agent A' }];
    const result = extractMermaidChips(chart);
    expect(result.source).toBe(chart);
    expect(result.chips).toEqual([]);
  });

  it('never waits on the roster for a bare word or a kind-prefixed href', () => {
    const chart = [
      'graph TD',
      `  A[${AGENT}] --> B["[Draft](doc-abc)"]`,
      `  B --> C["Ask [Bob](${AGENT})"]`,
    ].join('\n');
    expect(extractMermaidChips(chart).lookups).toEqual(NO_LOOKUPS);
  });
});
