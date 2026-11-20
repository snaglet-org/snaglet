import { describe, it, expect } from '@jest/globals';
import { condenseProcessedToolResults } from '@server/services/SocketService/handlers/chatHelpers';
import { estimateTokens } from '@server/services/TokenEstimator';

// Builders
// A tool call routes through the `action` gateway: name='action', input carries
// the real tool + params. The condenser unwraps it exactly like dispatch does.
function toolUse(id: string, tool: string, params: Record<string, unknown>) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'tool_use' as const, id, name: 'action', input: { tool, params } }],
  };
}
function toolResult(id: string, content: string) {
  return {
    role: 'user' as const,
    content: [{ type: 'tool_result' as const, tool_use_id: id, content }],
  };
}
const asst = (text: string) => ({ role: 'assistant' as const, content: text });

// Read the (single) tool_result content at a message index.
function resultAt(msgs: unknown[], idx: number): string {
  return (msgs[idx] as { content: Array<{ content: string }> }).content[0].content;
}

const tok = (s: string) => estimateTokens(s, 'anthropic');

// Distinct, benign config-file bodies (no "error"/"failed"/"exception" prefix).
function envFile(tag: string, lines = 40): string {
  const body = [`# config for ${tag}`, 'HOST=localhost'];
  for (let i = 0; i < lines; i++) body.push(`${tag}_KEY_${i}=value_${i}`);
  body.splice(3, 0, 'PORT=4001');
  return body.join('\n') + '\n';
}

// Tier 2 + low-pressure: the .env scenario
describe('condenseProcessedToolResults — low pressure keeps everything whole', () => {
  it('reads three different config files under low pressure → all whole (no re-fetch)', () => {
    const a = envFile('A');
    const b = envFile('B');
    const c = envFile('C');
    const msgs = [
      toolUse('1', 'file_read', { path: '/a/.env.local' }),
      toolResult('1', a),
      asst('read a'),
      toolUse('2', 'file_read', { path: '/b/.env.local' }),
      toolResult('2', b),
      asst('read b'),
      toolUse('3', 'file_read', { path: '/c/.env.local' }),
      toolResult('3', c), // most recent
    ];

    // Comfortable bulk budget → Tier 3 never fires; the three files are distinct
    // targets → Tier 2 never fires. Everything stays verbatim.
    const out = condenseProcessedToolResults(msgs, {
      minChars: 100,
      toolBulkBudget: 1_000_000,
      provider: 'anthropic',
    });

    expect(resultAt(out, 1)).toBe(a);
    expect(resultAt(out, 4)).toBe(b);
    expect(resultAt(out, 7)).toBe(c);
  });
});

describe('condenseProcessedToolResults — Tier 2 supersede dedup (always on, zero-loss)', () => {
  it('collapses older copies of the same target to a pointer; newest stays whole', () => {
    const big = envFile('X', 60);
    const msgs = [
      toolUse('1', 'file_read', { path: '/x' }),
      toolResult('1', big),
      asst('read'),
      toolUse('2', 'file_read', { path: '/x' }),
      toolResult('2', big),
      asst('read again'),
      toolUse('3', 'file_read', { path: '/x' }),
      toolResult('3', big), // newest — protected
    ];

    // No budget → Tier 3 disabled; supersede still runs.
    const out = condenseProcessedToolResults(msgs, { minChars: 100 });

    expect(resultAt(out, 1)).toContain('superseded read');
    expect(resultAt(out, 4)).toContain('superseded read');
    expect(resultAt(out, 7)).toBe(big); // current knowledge retained whole
  });

  it('does not let a narrower range read supersede a broader full read (partial-vs-full)', () => {
    const full = envFile('FULL', 60);
    const range = 'lines 1-5 of /x\nPORT=4001\n';
    const msgs = [
      toolUse('f', 'file_read', { path: '/x' }),
      toolResult('f', full),
      asst('read full'),
      toolUse('r', 'file_read', { path: '/x', start_line: 1, end_line: 5 }),
      toolResult('r', range), // newest, but narrower
    ];

    const out = condenseProcessedToolResults(msgs, { minChars: 50 });

    // The earlier full read must stay whole — a range read does not cover it.
    expect(resultAt(out, 1)).toBe(full);
    expect(resultAt(out, 4)).toBe(range);
  });

  it('does not dedupe across a write: read → edit(same path) → read keeps both whole', () => {
    const before = envFile('BEFORE', 60);
    const after = envFile('AFTER', 60);
    const msgs = [
      toolUse('r1', 'file_read', { path: '/x' }),
      toolResult('r1', before),
      asst('read'),
      toolUse('e1', 'file_edit', { path: '/x', edits: [{ old_text: 'a', new_text: 'b' }] }),
      toolResult('e1', 'ok edited'),
      asst('edited'),
      toolUse('r2', 'file_read', { path: '/x' }),
      toolResult('r2', after), // newest, different generation
    ];

    const out = condenseProcessedToolResults(msgs, { minChars: 50 });

    // The pre-write read is a different generation than the post-write read —
    // it must not be collapsed as "superseded".
    expect(resultAt(out, 1)).toBe(before);
    expect(resultAt(out, 7)).toBe(after);
  });
});

describe('condenseProcessedToolResults — Tier 3 pressure shedding (oldest-first)', () => {
  const OLD = 'A'.repeat(6000);
  const MID = 'B'.repeat(3000);
  const REC = 'C'.repeat(500);
  const build = () => [
    toolUse('1', 'file_read', { path: '/a' }),
    toolResult('1', OLD),
    asst('read a'),
    toolUse('2', 'file_read', { path: '/b' }),
    toolResult('2', MID),
    asst('read b'),
    toolUse('3', 'file_read', { path: '/c' }),
    toolResult('3', REC), // most recent — protected
  ];

  it('sheds only as much as needed, oldest-first; newer copies stay whole', () => {
    const total = tok(OLD) + tok(MID) + tok(REC);
    // Budget just below total: shedding the oldest alone relieves it.
    const out = condenseProcessedToolResults(build(), {
      minChars: 100,
      toolBulkBudget: total - 1,
      provider: 'anthropic',
    });

    expect(resultAt(out, 1).length).toBeLessThan(OLD.length); // oldest shed
    expect(resultAt(out, 4)).toBe(MID); // newer unique copy untouched
    expect(resultAt(out, 7)).toBe(REC); // most-recent protected
  });

  it('under extreme pressure sheds all processed unique results but protects the most recent', () => {
    const out = condenseProcessedToolResults(build(), {
      minChars: 100,
      toolBulkBudget: 1,
      provider: 'anthropic',
    });

    expect(resultAt(out, 1).length).toBeLessThan(OLD.length);
    expect(resultAt(out, 4).length).toBeLessThan(MID.length);
    expect(resultAt(out, 7)).toBe(REC); // never condensed
  });

  it('preserves verbatim routing when shedding a file_read (no fake DB table)', () => {
    // Pipe-heavy source code — the content-sniffer would mis-read it as a table.
    const code =
      Array.from({ length: 200 }, (_, i) => `  const v${i} = a${i} || b${i} | c${i};`).join('\n') +
      '\n';
    const msgs = [
      toolUse('1', 'file_read', { path: '/x.ts' }),
      toolResult('1', code),
      asst('read'),
      toolUse('2', 'file_read', { path: '/y.ts' }),
      toolResult('2', 'short'),
    ];

    const out = condenseProcessedToolResults(msgs, {
      minChars: 50,
      toolBulkBudget: 1,
      provider: 'anthropic',
    });

    const shed = resultAt(out, 1);
    expect(shed).not.toContain('rows returned');
    expect(shed).not.toContain('columns:');
    expect(shed).toContain('const v0 = a0'); // real file text preserved (head+tail)
  });

  it('still condenses a genuinely tabular result as rows/columns when shed', () => {
    // database_query's real shape: header, `---+---` separator, rows.
    const table = [
      'id | title',
      '---+------',
      ...Array.from({ length: 200 }, (_, i) => `${i} | Row ${i}`),
    ].join('\n');
    const msgs = [
      toolUse('1', 'database_query', { sql: 'x' }),
      toolResult('1', table),
      asst('got rows'),
      toolUse('2', 'date_time', {}),
      toolResult('2', 'now'),
    ];

    const out = condenseProcessedToolResults(msgs, {
      minChars: 50,
      toolBulkBudget: 1,
      provider: 'anthropic',
    });

    const shed = resultAt(out, 1);
    expect(shed).toContain('rows returned');
    expect(shed).toContain('columns: id, title');
  });
});

// Error detection must not exempt ordinary text output
describe('condenseProcessedToolResults — error flag vs content sniffing', () => {
  function errorResult(id: string, content: string) {
    return {
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: id, content, is_error: true }],
    };
  }
  const tail = (tag: string) => [
    toolUse('9', 'file_read', { path: `/${tag}` }),
    toolResult('9', 'ok'),
  ];

  it('condenses a 12k file read that starts with `import { getErrorMessage }`', () => {
    const code =
      "import { getErrorMessage } from '@snaglet/shared/utils';\n" +
      Array.from({ length: 400 }, (_, i) => `export const value${i} = compute(${i});`).join('\n') +
      '\n';
    expect(code.length).toBeGreaterThan(12_000);
    const out = condenseProcessedToolResults(
      [
        toolUse('1', 'file_read', { path: '/x.ts' }),
        toolResult('1', code),
        asst('read'),
        ...tail('a'),
      ],
      { minChars: 100, toolBulkBudget: 1, provider: 'anthropic' }
    );
    const shed = resultAt(out, 1);
    expect(shed.length).toBeLessThan(code.length);
    expect(shed).toContain('import { getErrorMessage }');
  });

  it('condenses a shell `FAIL …` test run and keeps its last lines', () => {
    const lines = ['FAIL tests/unit/foo.test.ts — Test suite failed to run'];
    for (let i = 0; i < 300; i++) lines.push(`  ✓ case number ${i} passes as expected`);
    lines.push('Tests:       1 failed, 300 passed, 301 total');
    const run = JSON.stringify({ output: lines.join('\n') });
    const out = condenseProcessedToolResults(
      [
        toolUse('1', 'exec_command', { cmd: 'jest' }),
        toolResult('1', run),
        asst('ran'),
        ...tail('b'),
      ],
      { minChars: 100, toolBulkBudget: 1, provider: 'anthropic' }
    );
    const shed = resultAt(out, 1);
    expect(shed.length).toBeLessThan(run.length);
    expect(shed).toContain('Tests:       1 failed, 300 passed, 301 total');
    expect(shed).not.toContain('JSON object');
  });

  it('keeps a real is_error result whole, even for a text tool', () => {
    const err = 'cat: /nope: No such file or directory\n' + 'x'.repeat(5000);
    const out = condenseProcessedToolResults(
      [
        toolUse('1', 'exec_command', { cmd: 'cat /nope' }),
        errorResult('1', err),
        asst('saw'),
        ...tail('c'),
      ],
      { minChars: 100, toolBulkBudget: 1, provider: 'anthropic' }
    );
    expect(resultAt(out, 1)).toBe(err);
  });
});

// An old skill load sheds to the fixed marker
describe('condenseProcessedToolResults — skill(op:load) results', () => {
  const load = (slug: string, version: string) =>
    `[Skill ${slug} · version ${version} · read supporting files with skill {op: "read", slug, path}]\n` +
    Array.from({ length: 300 }, (_, i) => `- rule ${i}: always do x | y || z`).join('\n');

  it('under pressure an older load becomes the marker; the newest result stays whole', () => {
    const newest = load('deploy', 'fedcba987654');
    const msgs = [
      toolUse('1', 'skill', { op: 'load', slug: 'pr-review' }),
      toolResult('1', load('pr-review', 'abcdef012345')),
      asst('loaded'),
      toolUse('2', 'skill', { op: 'load', slug: 'deploy' }),
      toolResult('2', newest),
    ];
    const out = condenseProcessedToolResults(msgs, {
      minChars: 50,
      toolBulkBudget: 1,
      provider: 'anthropic',
    });
    expect(resultAt(out, 1)).toBe('[skill pr-review @abcdef01 loaded — skill(op:load) to reload]');
    expect(resultAt(out, 4)).toBe(newest);
  });

  it('low pressure keeps the load whole', () => {
    const body = load('pr-review', 'abcdef012345');
    const msgs = [
      toolUse('1', 'skill', { op: 'load', slug: 'pr-review' }),
      toolResult('1', body),
      asst('loaded'),
      toolUse('2', 'date_time', {}),
      toolResult('2', 'now'),
    ];
    const out = condenseProcessedToolResults(msgs, {
      minChars: 50,
      toolBulkBudget: 1_000_000,
      provider: 'anthropic',
    });
    expect(resultAt(out, 1)).toBe(body);
  });
});
