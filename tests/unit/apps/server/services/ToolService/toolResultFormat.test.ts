import {
  resolveEffectiveToolName,
  isVerbatimTextTool,
  VERBATIM_TEXT_TOOLS,
  condenseVerbatimText,
  detectDelimitedTable,
  summarizeToolResultContent,
  unwrapOutputEnvelope,
  isToolResultError,
  skillLoadMarker,
} from '@server/services/ToolService/toolResultFormat';

/**
 * toolResultFormat lets result condensers route by the originating tool's
 * return type. Mis-resolving the tool behind the `action` gateway caused
 * file_read output to be re-rendered as a bogus DB table, so the
 * name-resolution + verbatim classification are worth pinning down.
 */
describe('resolveEffectiveToolName', () => {
  test('returns the block name for directly-listed (non-action) tools', () => {
    expect(resolveEffectiveToolName({ name: 'file_read' })).toBe('file_read');
  });

  test('unwraps the real tool id from the action gateway input', () => {
    expect(resolveEffectiveToolName({ name: 'action', input: { tool: 'File Read' } })).toBe(
      'file_read'
    );
    expect(
      resolveEffectiveToolName({ name: 'action', input: { tool_name: 'Read Multiple Files' } })
    ).toBe('read_multiple_files');
  });

  test('decodes persisted action activity names without rewriting history', () => {
    expect(resolveEffectiveToolName({ name: 'action__read_multiple_files' })).toBe(
      'read_multiple_files'
    );
  });

  test('resolves the inner tool even when the block has no name', () => {
    expect(resolveEffectiveToolName({ input: { tool: 'foo-bar' } })).toBe('foo_bar');
  });

  test('falls back to the block name when no inner tool is present', () => {
    expect(resolveEffectiveToolName({ name: 'action', input: {} })).toBe('action');
    expect(resolveEffectiveToolName({ name: 'action' })).toBe('action');
    expect(resolveEffectiveToolName({ name: 'action', input: { tool: '   ' } })).toBe('action');
  });

  test('returns undefined when nothing resolves', () => {
    expect(resolveEffectiveToolName({})).toBeUndefined();
    expect(resolveEffectiveToolName({ name: 42 })).toBeUndefined();
  });
});

describe('isVerbatimTextTool', () => {
  test('is true only for verbatim text tools', () => {
    expect(isVerbatimTextTool('file_read')).toBe(true);
    expect(isVerbatimTextTool('read_multiple_files')).toBe(true);
  });

  test('is false for other tools and undefined', () => {
    expect(isVerbatimTextTool('memory')).toBe(false);
    expect(isVerbatimTextTool('database_query')).toBe(false);
    expect(isVerbatimTextTool('FILE_READ')).toBe(false);
    expect(isVerbatimTextTool(undefined)).toBe(false);
  });

  test('classification matches the exported set', () => {
    for (const tool of VERBATIM_TEXT_TOOLS) {
      expect(isVerbatimTextTool(tool)).toBe(true);
    }
  });
});

/**
 * condenseVerbatimText is the payload-preserving head+tail condenser. The RC1
 * bug was slicing to the first 150 chars, which for a config file returned only
 * the comment banner and discarded the payload (PORT=4001), forcing re-fetches.
 */
describe('condenseVerbatimText', () => {
  test('keeps content whole when at or below budget', () => {
    const small = 'KEY_A=1\nKEY_B=2\nPORT=4001\n';
    expect(condenseVerbatimText(small, { budget: 2000 })).toBe(small);
  });

  test('banner file: KEY=value payload survives head+tail (not banner-only)', () => {
    // Leading multi-line comment banner (~180 chars), then env KEY=value lines.
    const banner =
      '# ------------------------------------------\n# App config — do not edit by hand\n# ------------------------------------------\n';
    const keys = Array.from({ length: 40 }, (_, i) => `KEY_${i}=value_${i}`);
    // Ensure the payload we care about sits right after the banner (in the head).
    keys.splice(2, 0, 'PORT=4001');
    const content = banner + keys.join('\n') + '\n';

    // Force condensation with a small budget so head+tail actually applies.
    const out = condenseVerbatimText(content, { budget: 400 });

    // Old behavior (slice 0,150) returned only the banner. New behavior keeps
    // the KEY=value payload in the head, the last keys in the tail, and an
    // honest marker between.
    expect(out).toContain('PORT=4001');
    expect(out).toContain('KEY_39=value_39'); // last line survives in the tail
    expect(out).toMatch(/\[…\d+ chars condensed…\]/);
    expect(out.length).toBeLessThan(content.length);
  });

  test('large output: head is first ~60%, tail is last ~25%, marker between', () => {
    const budget = 1000;
    const head = 'H'.repeat(3000);
    const tail = 'T'.repeat(3000);
    const content = head + 'MIDDLE_DROPPED'.repeat(200) + tail;

    const out = condenseVerbatimText(content, { budget });
    const headChars = Math.floor(budget * 0.6); // 600
    const tailChars = Math.floor(budget * 0.25); // 250

    expect(out.startsWith('H'.repeat(headChars))).toBe(true);
    expect(out.endsWith('T'.repeat(tailChars))).toBe(true);
    expect(out).not.toContain('MIDDLE_DROPPED');
    const expectedCondensed = content.length - headChars - tailChars;
    expect(out).toContain(`[…${expectedCondensed} chars condensed…]`);
  });
});

/**
 * Condensed shell/table results must reach agents intact: `sed` output with
 * `||` must not become "[N rows returned, columns: if (!name, …]", `git show --stat`
 * must not become a table, and `{"output": "…"}` must not collapse to
 * "[JSON object with 1 key]".
 */
describe('isVerbatimTextTool keys by canonical id', () => {
  test('legacy ids follow their canonical tool', () => {
    for (const id of ['exec_command', 'shell_exec', 'write_stdin', 'file_read', 'shell', 'file']) {
      expect(isVerbatimTextTool(id)).toBe(true);
    }
    expect(isVerbatimTextTool('table_read')).toBe(true);
    expect(isVerbatimTextTool('table_list')).toBe(true); // pins table op read
    expect(isVerbatimTextTool('table')).toBe(true); // table(op)
    expect(isVerbatimTextTool('search')).toBe(true);
  });
});

describe('unwrapOutputEnvelope', () => {
  test('unwraps a one-key {output} envelope', () => {
    expect(unwrapOutputEnvelope(JSON.stringify({ output: 'a\nb' }))).toBe('a\nb');
  });
  test('leaves other JSON and text alone', () => {
    const two = JSON.stringify({ output: 'x', code: 1 });
    expect(unwrapOutputEnvelope(two)).toBe(two);
    expect(unwrapOutputEnvelope('plain')).toBe('plain');
    expect(unwrapOutputEnvelope('{"output": broken')).toBe('{"output": broken');
  });
});

const SED_WITH_OR = Array.from(
  { length: 300 },
  (_, i) => `    if (!name${i} || name${i}.length < 2) continue;`
).join('\n');
const GIT_STAT = [
  'abc1234 feat(example): add a sample feature',
  '',
  ...Array.from({ length: 60 }, (_, i) => ` apps/server/src/file${i}.ts | ${i + 1} ++++--`),
  ' 60 files changed, 199 insertions(+), 4 deletions(-)',
].join('\n');

describe('detectDelimitedTable', () => {
  test('pipes without a separator row are not a table', () => {
    expect(detectDelimitedTable(SED_WITH_OR)).toBeNull();
    expect(detectDelimitedTable(GIT_STAT)).toBeNull();
    expect(detectDelimitedTable('a | b\nc | d')).toBeNull();
  });
  test('markdown, psql-style and TSV tables are detected', () => {
    expect(detectDelimitedTable('| id | title |\n|---|---|\n| 1 | A |\n| 2 | B |')).toEqual({
      columns: ['id', 'title'],
      rows: ['| 1 | A |', '| 2 | B |'],
    });
    expect(detectDelimitedTable('id | title\n---+------\n1 | A')?.columns).toEqual(['id', 'title']);
    expect(detectDelimitedTable('id\tname\n1\tA\n2\tB')).toEqual({
      columns: ['id', 'name'],
      rows: ['1\tA', '2\tB'],
    });
  });
});

describe('summarizeToolResultContent', () => {
  const live = (content: string, toolName?: string) =>
    summarizeToolResultContent(content, { toolName, onError: 'keep' });

  test('sed output with || stays text, even from an unknown tool', () => {
    const out = live(SED_WITH_OR, 'some_tool');
    expect(out).not.toContain('rows returned');
    expect(out).toContain('chars condensed');
    expect(out.startsWith('    if (!name0 || name0.length < 2) continue;')).toBe(true);
  });

  test('git show --stat is not a table', () => {
    const out = live(GIT_STAT, 'some_tool');
    expect(out).not.toContain('rows returned');
    expect(out).toContain('60 files changed');
  });

  test('a wrapped shell result is unwrapped and keeps its end generously', () => {
    const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\nexit code 1';
    const out = live(JSON.stringify({ output: body }), 'exec_command');
    expect(out).not.toContain('JSON object');
    expect(out.startsWith('line 0')).toBe(true);
    expect(out.endsWith('exit code 1')).toBe(true);
    const [head, tail] = out.split(/\n\[…\d+ chars condensed…\]\n/);
    expect(tail.length).toBeGreaterThanOrEqual(head.length);
  });

  test('table_read TSV stays text (it is the agent-facing row data)', () => {
    const tsv = [
      'id\tname\tstatus',
      ...Array.from({ length: 200 }, (_, i) => `${i}\trow ${i}\tDone`),
    ].join('\n');
    const out = live(tsv, 'table_read');
    expect(out).not.toContain('rows returned');
    expect(out.startsWith('id\tname\tstatus')).toBe(true);
  });

  test('a real markdown table from another tool is still summarized as a table', () => {
    const md = [
      '| id | title |',
      '|---|---|',
      ...Array.from({ length: 50 }, (_, i) => `| ${i} | T${i} |`),
    ].join('\n');
    const out = live(md, 'some_tool');
    expect(out).toContain('[50 rows returned, columns: id, title]');
    expect(out).toContain('[…45 more rows]');
  });

  test('JSON objects keep a key:value preview; errors per mode', () => {
    expect(live(JSON.stringify({ id: 'doc-1', title: 'T' }))).toContain('title: "T"');
    const err = 'Error: boom ' + 'x'.repeat(500);
    expect(live(err)).toBe(err);
    expect(summarizeToolResultContent(err, { onError: 'flag' })).toMatch(/^ERROR: Error: boom/);
  });
});

describe('isToolResultError', () => {
  test('a real is_error flag always wins', () => {
    expect(isToolResultError('all good', { toolName: 'shell', isError: true })).toBe(true);
  });

  test('text tools are never judged by content (legacy ids included)', () => {
    const code = "import { getErrorMessage } from '@snaglet/shared/utils';\n";
    expect(isToolResultError(code, { toolName: 'file_read' })).toBe(false);
    expect(
      isToolResultError(JSON.stringify({ output: 'FAIL x.test.ts: 1 failed' }), {
        toolName: 'exec_command',
      })
    ).toBe(false);
    expect(isToolResultError('{"error":"boom"}', { toolName: 'table_read' })).toBe(false);
  });

  test('other tools: JSON error envelopes count, even when is_error is false', () => {
    expect(
      isToolResultError('{"success":false,"message":"x"}', {
        toolName: 'memory_save',
        isError: false,
      })
    ).toBe(true);
    expect(isToolResultError('{"error":"boom"}', { toolName: 'web_fetch' })).toBe(true);
  });

  test('other tools: keyword sniff is only a fallback when no flag is known', () => {
    expect(isToolResultError('Request failed with 500', { toolName: 'web_fetch' })).toBe(true);
    expect(
      isToolResultError('Request failed with 500', { toolName: 'web_fetch', isError: false })
    ).toBe(false);
  });

  test('summarizeToolResultContent: a file read mentioning errors condenses as text', () => {
    const code = "import { getErrorMessage } from 'x';\n" + 'const a = 1;\n'.repeat(1000);
    const out = summarizeToolResultContent(code, { toolName: 'file', onError: 'keep' });
    expect(out.length).toBeLessThan(code.length);
    expect(out).toContain('import { getErrorMessage }');
  });

  test('summarizeToolResultContent: is_error results are kept (keep) or flagged (flag)', () => {
    const err = 'x'.repeat(5000);
    expect(
      summarizeToolResultContent(err, { toolName: 'shell', onError: 'keep', isError: true })
    ).toBe(err);
    expect(
      summarizeToolResultContent(err, { toolName: 'shell', onError: 'flag', isError: true })
    ).toMatch(/^ERROR: /);
  });
});

describe('condensed skill(op:load) results are a fixed marker', () => {
  const body = [
    '---',
    'name: pr-review',
    'description: Review a PR | checklist',
    '---',
    '| step | what |',
    '|---|---|',
    ...Array.from({ length: 80 }, (_, i) => `| ${i} | do thing ${i} || other |`),
  ].join('\n');
  const load =
    '[Skill pr-review · version 0123456789ab · read supporting files with skill {op: "read", slug, path}]\n' +
    body;
  const MARKER = '[skill pr-review @01234567 loaded — skill(op:load) to reload]';

  test('skillLoadMarker: slug + first 8 hex of the version; null for anything else', () => {
    expect(skillLoadMarker(load)).toBe(MARKER);
    // Loads written before skills became personal-only carry `(<scope>)`.
    expect(skillLoadMarker(load.replace('pr-review ·', 'pr-review (personal) ·'))).toBe(MARKER);
    expect(skillLoadMarker('[Skill pr-review · scripts/run.sh]\n#!/bin/sh')).toBeNull();
    expect(skillLoadMarker(body)).toBeNull();
    expect(skillLoadMarker('')).toBeNull();
  });

  test('a part of a long skill keeps its part number, so it is not taken for the whole', () => {
    const part = load.replace('0123456789ab ·', '0123456789ab · part 2 of 5 ·');
    expect(skillLoadMarker(part)).toBe(
      '[skill pr-review @01234567 part 2 of 5 loaded — skill(op:load, part:2) to reload]'
    );
    // A part of a supporting file (op:read) is still not a load result.
    expect(
      skillLoadMarker('[Skill pr-review · ref.md · version 0123456789ab · part 1 of 3]\nx')
    ).toBeNull();
  });

  test.each([['skill'], [undefined]])(
    'load result from %s condenses to exactly the marker in both modes',
    (toolName) => {
      for (const onError of ['keep', 'flag'] as const) {
        const out = summarizeToolResultContent(load, { toolName, onError });
        expect(out).toBe(MARKER);
        expect(out).not.toContain('rows returned');
        expect(out).not.toContain('do thing');
      }
    }
  );

  test('a skill(op:read) supporting file is condensed as plain text, not a table or marker', () => {
    const read = '[Skill pr-review · checklist.md]\n' + body;
    const out = summarizeToolResultContent(read, { toolName: 'skill', onError: 'keep' });
    expect(out).not.toContain('rows returned');
    expect(out).not.toContain('loaded — skill(op:load)');
  });

  test('a skill error stays an error', () => {
    const err = "Error: Skill 'x' is not available in this thread.";
    expect(
      summarizeToolResultContent(err, { toolName: 'skill', onError: 'keep', isError: true })
    ).toBe(err);
  });

  test('another tool echoing a load header is not given the marker', () => {
    const out = summarizeToolResultContent(load, { toolName: 'file', onError: 'keep' });
    expect(out).not.toBe(MARKER);
  });
});
