/**
 * frontmatter — the hand-rolled YAML header writer.
 *
 * The header is machine-read and carries user-controlled strings (titles,
 * agent names, summary text). The invariant under test is that no input value
 * can escape its own scalar and become structure.
 */

import {
  quoteYamlString,
  renderFrontmatter,
  withFrontmatter,
} from '@server/services/ExportService/frontmatter';

describe('quoteYamlString', () => {
  it('escapes quotes and backslashes', () => {
    expect(quoteYamlString('a "b" c')).toBe('"a \\"b\\" c"');
    expect(quoteYamlString('back\\slash')).toBe('"back\\\\slash"');
  });

  it('flattens newlines so a value can never span lines', () => {
    // A multi-line value would otherwise let the second line pose as a key.
    expect(quoteYamlString('one\ntwo')).toBe('"one\\ntwo"');
    expect(quoteYamlString('cr\rlf')).toBe('"cr\\rlf"');
  });

  it('escapes control characters as unicode', () => {
    expect(quoteYamlString(String.fromCharCode(0))).toBe('"\\u0000"');
  });
});

describe('renderFrontmatter', () => {
  it('emits delimiters and preserves key order', () => {
    const out = renderFrontmatter({ snaglet_kind: 'doc', id: 'doc-1', title: 'Notes' });
    expect(out).toBe(
      ['---', 'snaglet_kind: "doc"', 'id: "doc-1"', 'title: "Notes"', '---', ''].join('\n')
    );
  });

  it('quotes every string, including ones that look like other types', () => {
    // Unquoted, each of these would parse as something other than a string.
    const out = renderFrontmatter({
      a: 'true',
      b: '123',
      c: 'null',
      d: '2026-01-01',
      e: 'yes',
    });
    expect(out).toContain('a: "true"');
    expect(out).toContain('b: "123"');
    expect(out).toContain('c: "null"');
    expect(out).toContain('d: "2026-01-01"');
    expect(out).toContain('e: "yes"');
  });

  it('cannot be escaped by a title that tries to inject structure', () => {
    const out = renderFrontmatter({
      title: 'x"\nexported_by: "attacker',
      exported_by: 'test_user',
    });
    const lines = out.split('\n');
    // Exactly one exported_by line, and it is the real one.
    expect(lines.filter((l) => l.startsWith('exported_by:'))).toEqual(['exported_by: "test_user"']);
    // The forged text survives as inert content inside the title scalar.
    expect(out).toContain('\\nexported_by:');
  });

  it('cannot be escaped by a title containing the closing delimiter', () => {
    const out = renderFrontmatter({ title: '---\nrogue: 1' });
    // Three delimiter-only lines would mean the header closed early.
    expect(out.split('\n').filter((l) => l === '---')).toHaveLength(2);
  });

  it('renders scalar types without quoting non-strings', () => {
    const out = renderFrontmatter({ count: 42, truncated: false, missing: null });
    expect(out).toContain('count: 42');
    expect(out).toContain('truncated: false');
    expect(out).toContain('missing: null');
  });

  it('renders a non-finite number as null rather than invalid YAML', () => {
    expect(renderFrontmatter({ n: Number.NaN })).toContain('n: null');
    expect(renderFrontmatter({ n: Number.POSITIVE_INFINITY })).toContain('n: null');
  });

  it('omits undefined but keeps empty lists', () => {
    const out = renderFrontmatter({ present: 'x', absent: undefined, compactions: [] });
    expect(out).not.toContain('absent');
    // "no compactions" is a real answer and must be stated.
    expect(out).toContain('compactions: []');
  });

  it('renders scalar lists', () => {
    expect(renderFrontmatter({ tags: ['a', 'b'] })).toContain('tags:\n  - "a"\n  - "b"');
  });

  it('renders lists of flat records with aligned continuation lines', () => {
    const out = renderFrontmatter({
      compactions: [
        { agent: 'clio', version: 3, messages_covered: 477 },
        { agent: 'venus', version: 1, messages_covered: 12 },
      ],
    });
    expect(out).toContain('  - agent: "clio"\n    version: 3\n    messages_covered: 477');
    expect(out).toContain('  - agent: "venus"\n    version: 1\n    messages_covered: 12');
  });
});

describe('withFrontmatter', () => {
  it('emits the body verbatim after the header', () => {
    const out = withFrontmatter({ snaglet_kind: 'doc' }, '# Title\n\nBody text.');
    expect(out).toBe('---\nsnaglet_kind: "doc"\n---\n\n# Title\n\nBody text.\n');
  });

  it('leaves a horizontal rule in the body alone', () => {
    // Frontmatter is only frontmatter at the top of a file; a later `---` is
    // an ordinary rule and must not be mangled.
    const out = withFrontmatter({ snaglet_kind: 'doc' }, 'before\n\n---\n\nafter');
    expect(out).toContain('before\n\n---\n\nafter');
  });

  it('handles an empty body without leaving stray blank lines', () => {
    expect(withFrontmatter({ snaglet_kind: 'doc' }, '   ')).toBe('---\nsnaglet_kind: "doc"\n---\n');
  });
});
