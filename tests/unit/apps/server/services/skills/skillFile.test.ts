import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_FILE_MAX_BYTES,
  hashSkillContent,
  isContained,
  parseSkillMarkdown,
  readSkillFolder,
  readSkillFolderText,
} from '@server/services/skills/skillFile';

const VALID = '---\nname: Demo\ndescription: Does a demo thing.\n---\n# Body\n';

describe('parseSkillMarkdown', () => {
  it('parses name, description and body', () => {
    const r = parseSkillMarkdown(VALID);
    expect(r).toEqual({
      ok: true,
      value: { name: 'Demo', description: 'Does a demo thing.', body: '# Body\n' },
    });
  });

  it('accepts CRLF, a BOM, quotes and comments', () => {
    const r = parseSkillMarkdown(
      '\uFEFF---\r\n# note\r\nname: "Quoted: yes"\r\ndescription: \'d\'\r\n---\r\nbody'
    );
    expect(r).toMatchObject({ ok: true, value: { name: 'Quoted: yes', description: 'd' } });
  });

  it('ignores standard Agent Skills keys it does not read', () => {
    const r = parseSkillMarkdown(
      [
        '---',
        'name: test-skill',
        'description: Does a test thing.',
        'license: MIT',
        'allowed-tools: Read, Grep, Glob',
        'argument-hint: "[optional: notes]"',
        'version: 1.0.0',
        'tags: [alpha, beta]',
        'metadata:',
        '  author: test-author',
        '  version: "1.0"',
        '  nested:',
        '    - item-a',
        'allowed-tools-list:',
        '- Read',
        '- Write',
        '# a comment',
        '---',
        'body',
      ].join('\n')
    );
    expect(r).toEqual({
      ok: true,
      value: { name: 'test-skill', description: 'Does a test thing.', body: 'body' },
    });
  });

  it('accepts a long description up to the cap', () => {
    const long = 'x'.repeat(SKILL_DESCRIPTION_MAX_CHARS);
    const r = parseSkillMarkdown(`---\nname: a\ndescription: ${long}\n---\n`);
    expect(SKILL_DESCRIPTION_MAX_CHARS).toBeGreaterThanOrEqual(1024);
    expect(r).toMatchObject({ ok: true, value: { description: long } });
  });

  it.each(['>-', '>', '>+'])('joins a folded %s description into one line', (header) => {
    const r = parseSkillMarkdown(
      `---\nname: a\ndescription: ${header}\n  First line of text\n  second line.\nlicense: MIT\n---\n`
    );
    expect(r).toMatchObject({
      ok: true,
      value: { name: 'a', description: 'First line of text second line.' },
    });
  });

  it('keeps line breaks in a literal | description', () => {
    const r = parseSkillMarkdown(
      '---\nname: a\ndescription: |\n  First line.\n  # not a comment\n\n  Last line.\n---\n'
    );
    expect(r).toMatchObject({
      ok: true,
      value: { description: 'First line.\n# not a comment\n\nLast line.' },
    });
  });

  it('folds plain and quoted multi-line descriptions', () => {
    const plain = parseSkillMarkdown(
      '---\nname: a\ndescription: Use when testing:\n  with a wrapped line\n  and another.\n---\n'
    );
    expect(plain).toMatchObject({
      ok: true,
      value: { description: 'Use when testing: with a wrapped line and another.' },
    });
    const quoted = parseSkillMarkdown(
      '---\nname: a\ndescription: "Say \\"hi\\" and\n  wrap here"\n---\n'
    );
    expect(quoted).toMatchObject({ ok: true, value: { description: 'Say "hi" and wrap here' } });
  });

  it('ignores keys that are not simple identifiers', () => {
    const r = parseSkillMarkdown(
      [
        '---',
        '1abc: one',
        'x.y: two',
        '"quoted key": three',
        'my key: four',
        'name: a',
        'description: b',
        '---',
      ].join('\n')
    );
    expect(r).toMatchObject({ ok: true, value: { name: 'a', description: 'b' } });
  });

  it('reads a value that starts on the next line', () => {
    const r = parseSkillMarkdown('---\nname:\n  a\ndescription:\n  Does a\n  thing.\n---\n');
    expect(r).toMatchObject({ ok: true, value: { name: 'a', description: 'Does a thing.' } });
  });

  it('decodes quote escapes', () => {
    const single = parseSkillMarkdown("---\nname: 'It''s a'\ndescription: b\n---\n");
    expect(single).toMatchObject({ ok: true, value: { name: "It's a" } });
    const double = parseSkillMarkdown(
      '---\nname: a\ndescription: "One\\nTwo \\u00e9 \\x41 \\\\ \\q"\n---\n'
    );
    expect(double).toMatchObject({ ok: true, value: { description: 'One\nTwo \u00e9 A \\ \\q' } });
  });

  it('keeps # lines inside a quoted multi-line value', () => {
    const r = parseSkillMarkdown('---\nname: a\ndescription: "Start\n  # middle\n  end"\n---\n');
    expect(r).toMatchObject({ ok: true, value: { description: 'Start # middle end' } });
  });

  it('drops # comment lines from a plain multi-line value', () => {
    const r = parseSkillMarkdown('---\nname: a\ndescription: Start\n  # note\n  end\n---\n');
    expect(r).toMatchObject({ ok: true, value: { description: 'Start end' } });
  });

  it('handles |- and an indentation indicator', () => {
    const strip = parseSkillMarkdown('---\nname: a\ndescription: |-\n  one\n  two\n\n---\n');
    expect(strip).toMatchObject({ ok: true, value: { description: 'one\ntwo' } });
    // |2 sets the indent to 2, so the extra spaces on later lines are kept.
    const indented = parseSkillMarkdown('---\nname: a\ndescription: |2\n   one\n    two\n---\n');
    expect(indented).toMatchObject({ ok: true, value: { description: 'one\n  two' } });
  });

  it('folds > paragraphs and keeps more-indented lines', () => {
    const r = parseSkillMarkdown(
      [
        '---',
        'name: a',
        'description: >',
        '  First para',
        '  continues.',
        '',
        '  Second para.',
        '    indented detail',
        '  back.',
        '---',
      ].join('\n')
    );
    expect(r).toMatchObject({
      ok: true,
      value: { description: 'First para continues.\nSecond para.\n  indented detail\nback.' },
    });
  });

  it.each([
    ['no frontmatter', '# just markdown', /must start with/],
    ['unclosed', '---\nname: a\ndescription: b\n', /not closed/],
    ['duplicate key', '---\nname: a\nname: b\ndescription: c\n---\n', /Duplicate/],
    [
      'stray line',
      '---\nname: a\njust words\ndescription: b\n---\n',
      /Unsupported frontmatter line/,
    ],
    [
      'indented first line',
      '---\n  name: a\ndescription: b\n---\n',
      /Unsupported frontmatter line/,
    ],
    ['list description', '---\nname: a\ndescription:\n  - item\n---\n', /must be text/],
    ['mapping name', '---\nname:\n  first: a\ndescription: b\n---\n', /must be text/],
    ['missing name', '---\ndescription: b\nlicense: MIT\n---\n', /needs a name/],
    ['missing description', '---\nname: a\nlicense: MIT\n---\n', /needs a description/],
    ['empty block description', '---\nname: a\ndescription: >-\n---\n', /needs a description/],
    ['empty quoted description', '---\nname: a\ndescription: ""\n---\n', /needs a description/],
    [
      'list item after a value',
      '---\nname: a\n- foo\ndescription: b\n---\n',
      /list item after the value of "name"/,
    ],
    ['flow list description', '---\nname: a\ndescription: [b, c]\n---\n', /must be text/],
    ['flow mapping name', '---\nname: {first: a}\ndescription: b\n---\n', /must be text/],
    [
      'wrong-case name',
      '---\nName: a\ndescription: b\n---\n',
      /needs a name \(found "Name"; keys are case-sensitive\)/,
    ],
    ['wrong-case description', '---\nname: a\nDescription: b\n---\n', /found "Description"/],
  ])('rejects %s', (_label, raw, error) => {
    const r = parseSkillMarkdown(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(error);
  });

  it('caps the description', () => {
    const long = 'x'.repeat(SKILL_DESCRIPTION_MAX_CHARS + 1);
    const r = parseSkillMarkdown(`---\nname: a\ndescription: ${long}\n---\n`);
    expect(r).toMatchObject({ ok: false });
  });
});

describe('isContained', () => {
  it('rejects siblings that share a prefix', () => {
    expect(isContained('/a/skills', '/a/skills/x')).toBe(true);
    expect(isContained('/a/skills', '/a/skills-evil/x')).toBe(false);
    expect(isContained('/a/skills', '/a')).toBe(false);
  });
});

describe('readSkillFolder', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'skills-root-'));
    outside = await mkdtemp(path.join(os.tmpdir(), 'skills-outside-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  async function skill(slug: string, content: string) {
    await mkdir(path.join(root, slug), { recursive: true });
    await writeFile(path.join(root, slug, 'SKILL.md'), content, 'utf8');
  }

  it('reads a valid skill with a stable hash', async () => {
    await skill('demo', VALID);
    const a = await readSkillFolder(root, 'demo');
    const b = await readSkillFolder(root, 'demo');
    expect(a).toMatchObject({ status: 'valid', name: 'Demo', error: null });
    expect(a.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(b.contentHash).toBe(a.contentHash);
  });

  it('reads a standard Agent Skills folder with extra keys as valid', async () => {
    await skill(
      'test-skill',
      '---\nname: test-skill\ndescription: >-\n  Does a test\n  thing.\nlicense: MIT\nmetadata:\n  author: test-author\n---\n# Body\n'
    );
    expect(await readSkillFolder(root, 'test-skill')).toMatchObject({
      status: 'valid',
      name: 'test-skill',
      description: 'Does a test thing.',
      error: null,
    });
  });

  it('has no length limit: a 50,000-character SKILL.md is valid, hashed whole', async () => {
    const big = VALID + 'step line\n'.repeat(5_000);
    expect(big.length).toBeGreaterThan(50_000);
    await skill('big', big);
    const r = await readSkillFolder(root, 'big');
    expect(r).toMatchObject({ status: 'valid', name: 'Demo', error: null });
    expect(r.contentHash).toBe(hashSkillContent(big));
    // An edit at the very end changes the version: the hash covers the whole file.
    await skill('big', `${big}one more\n`);
    expect((await readSkillFolder(root, 'big')).contentHash).not.toBe(r.contentHash);
  });

  it('memory guard: a SKILL.md over 8 MB is invalid from its size, never read', async () => {
    await skill('huge', VALID);
    const file = path.join(root, 'huge', 'SKILL.md');
    await truncate(file, SKILL_FILE_MAX_BYTES + 512 * 1024); // sparse: nothing big written
    const r = await readSkillFolder(root, 'huge');
    expect(r).toMatchObject({ status: 'invalid', contentHash: null });
    expect(r.error).toBe('SKILL.md is over 8 MB (8.5 MB); Snaglet does not read files that large.');
    // Back under the guard, it is read and valid again.
    await truncate(file, VALID.length);
    expect((await readSkillFolder(root, 'huge')).status).toBe('valid');
  });

  it('readSkillFolderText returns the same text it validated and hashed', async () => {
    await skill('demo', VALID);
    const { result, text } = await readSkillFolderText(root, 'demo');
    expect(text).toBe(VALID);
    expect(result.contentHash).toBe(hashSkillContent(VALID));
    expect((await readSkillFolderText(root, 'nope')).text).toBeNull();
  });

  it('rejects slugs that are not lowercase-safe', async () => {
    await skill('Bad Name', VALID);
    expect((await readSkillFolder(root, 'Bad Name')).status).toBe('invalid');
    expect((await readSkillFolder(root, '../escape')).status).toBe('invalid');
  });

  it('rejects a SKILL.md symlinked outside the root', async () => {
    await writeFile(path.join(outside, 'secret.md'), VALID, 'utf8');
    await mkdir(path.join(root, 'linked'));
    await symlink(path.join(outside, 'secret.md'), path.join(root, 'linked', 'SKILL.md'));
    const r = await readSkillFolder(root, 'linked');
    expect(r).toMatchObject({ status: 'invalid' });
    expect(r.error).toMatch(/symlink escape/);
  });

  it('rejects a skill folder symlinked outside the root', async () => {
    await writeFile(path.join(outside, 'SKILL.md'), VALID, 'utf8');
    await symlink(outside, path.join(root, 'dirlink'));
    expect((await readSkillFolder(root, 'dirlink')).error).toMatch(/symlink escape/);
  });

  it('reports a missing file without throwing', async () => {
    await mkdir(path.join(root, 'empty'));
    const r = await readSkillFolder(root, 'empty');
    expect(r).toMatchObject({ status: 'invalid' });
    expect(r.error).toMatch(/ENOENT/);
  });
});
