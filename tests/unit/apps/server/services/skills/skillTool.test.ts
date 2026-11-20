/**
 * skill(op) handlers against a real temp skills root.
 * The effective set and the max_result_chars setting are stubbed; the thread
 * check, disk re-validation, containment and part splitting run for real.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const mockEffective = jest.fn();
jest.mock('@server/services/skills/skillCatalog', () => ({
  loadEffectiveSkills: (...a: unknown[]) => mockEffective(...a),
}));
const mockSettingRead = jest.fn();
jest.mock('@server/services/settings', () => ({
  settingsService: { read: (...a: unknown[]) => mockSettingRead(...a) },
}));

import type { SkillRegistryRow } from '@snaglet/db';
import { toolSettings } from '@server/services/settings/categories/tool';
import { hashSkillContent } from '@server/services/skills/skillFile';
import { loadSkill, pickSkill, readSkillFile } from '@server/services/skills/skillTool';
import tool from '@server/services/ToolService/tools/skills/skill/tool';

let root: string;
const ctx = { agentId: 'agent-1', threadId: 'thread-1' };
/** The max_result_chars value the stubbed setting returns. */
let maxResultChars = 12_000;

function row(slug: string, over: Partial<SkillRegistryRow> = {}): SkillRegistryRow {
  return {
    id: `id-${slug}`,
    scope: 'personal',
    projectId: null,
    slug,
    name: slug,
    description: '',
    sourcePath: path.join(root, slug, 'SKILL.md'),
    contentHash: null,
    status: 'valid',
    error: null,
    indexedAt: '',
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

async function writeSkill(slug: string, body = 'Do the thing.'): Promise<void> {
  await fs.mkdir(path.join(root, slug), { recursive: true });
  await fs.writeFile(
    path.join(root, slug, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: ${slug} skill\n---\n${body}\n`
  );
}

/** `n` numbered lines of about 50 characters each. */
function longBody(n: number): string {
  return Array.from({ length: n }, (_, i) => `Step ${i + 1}: ${'do the thing '.repeat(3)}`).join(
    '\n'
  );
}

/** Every part of one call, in order, read through the handler until the last. */
async function allParts(
  call: (part: number) => Promise<string>
): Promise<{ results: string[]; total: number }> {
  const first = await call(1);
  const total = Number(/ · part 1 of (\d+)/.exec(first)?.[1] ?? 1);
  const results = [first];
  for (let n = 2; n <= total; n++) results.push(await call(n));
  return { results, total };
}

/** A part's file text: without its header line and (all but the last) its footer. */
function bodyOf(result: string, n: number, total: number): string {
  const afterHeader = result.slice(result.indexOf('\n') + 1);
  if (n === total) return afterHeader;
  const beforeFooter = afterHeader.slice(0, afterHeader.lastIndexOf('[Part '));
  // A part that ends mid-line gets a line break before its footer: not file text.
  return result.includes(', ends mid-line — ') ? beforeFooter.slice(0, -1) : beforeFooter;
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snaglet-skilltool-')));
  await writeSkill('release', '# Release\nStep 1.');
  await fs.mkdir(path.join(root, 'release', 'templates'));
  await fs.writeFile(path.join(root, 'release', 'templates', 'pr.md'), 'PR template');
  await writeSkill('other');
  mockEffective.mockReset();
  mockEffective.mockResolvedValue([row('release')]);
  maxResultChars = 12_000;
  mockSettingRead.mockReset();
  mockSettingRead.mockImplementation(async (def: unknown) => {
    if (def !== toolSettings.maxResultChars) throw new Error('unexpected setting');
    return maxResultChars;
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('skill load', () => {
  it('returns SKILL.md with a version header, resolved for the calling agent + thread', async () => {
    const out = await loadSkill({ slug: 'release' }, ctx);
    expect(mockEffective).toHaveBeenCalledWith('agent-1', 'thread-1');
    expect(out.split('\n')[0]).toMatch(/^\[Skill release · version [0-9a-f]{12} · /);
    expect(out).toContain('# Release\nStep 1.');
  });

  it('refuses a skill outside the thread effective set with the agreed wording', async () => {
    await expect(loadSkill({ slug: 'other' }, ctx)).rejects.toThrow(
      "Skill 'other' is not available in this thread."
    );
  });

  it('re-validates on disk: a SKILL.md edited to be invalid is refused', async () => {
    await fs.writeFile(path.join(root, 'release', 'SKILL.md'), '---\nname: release\n---\nBody\n');
    await expect(loadSkill({ slug: 'release' }, ctx)).rejects.toThrow(
      /is invalid right now: Frontmatter needs a description/
    );
  });

  it('requires an agent inside a thread', async () => {
    await expect(loadSkill({ slug: 'release' }, { agentId: 'agent-1' })).rejects.toThrow(
      'skill can only be used by an agent inside a thread.'
    );
  });

  it('returns a skill that fits whole, with no part numbers or footer', async () => {
    await writeSkill('release', longBody(200)); // about 10,000 characters
    const out = await loadSkill({ slug: 'release' }, ctx);
    expect(out.length).toBeGreaterThan(9_000);
    expect(out.split('\n')[0]).not.toContain('part');
    expect(out).not.toContain('[Part ');
    await expect(loadSkill({ slug: 'release', part: 2 }, ctx)).rejects.toThrow(
      "Skill 'release' has 1 part; part 2 does not exist."
    );
  });

  it('loads a 50,000-character skill in parts, each within max_result_chars', async () => {
    await writeSkill('release', longBody(1_100));
    const raw = await fs.readFile(path.join(root, 'release', 'SKILL.md'), 'utf8');
    expect(raw.length).toBeGreaterThan(50_000);
    const version = hashSkillContent(raw).slice(0, 12);

    const { results, total } = await allParts((part) => loadSkill({ slug: 'release', part }, ctx));
    expect(total).toBeGreaterThan(4);
    results.forEach((out, i) => {
      const n = i + 1;
      // Never longer than one tool result can carry, so nothing is trimmed at ingest.
      expect(out.length).toBeLessThanOrEqual(12_000);
      // Every part carries the version of the whole file.
      expect(out.split('\n')[0]).toBe(
        `[Skill release · version ${version} · part ${n} of ${total} · read supporting files with skill {op: "read", slug, path}]`
      );
      const footer = `[Part ${n} of ${total} — call skill {"op":"load","slug":"release","part":${n + 1},"version":"${version}"} for the next part]`;
      if (n < total) expect(out.endsWith(footer)).toBe(true);
      else expect(out).not.toContain('[Part ');
    });
    // Split at line boundaries, and together the parts are the whole file.
    const bodies = results.map((out, i) => bodyOf(out, i + 1, total));
    expect(bodies.slice(0, -1).every((b) => b.endsWith('\n'))).toBe(true);
    expect(bodies.join('')).toBe(raw);

    await expect(loadSkill({ slug: 'release', part: total + 1 }, ctx)).rejects.toThrow(
      `Skill 'release' has ${total} parts; part ${total + 1} does not exist.`
    );
  });

  it('takes the part size from the max_result_chars setting, not a fixed number', async () => {
    await writeSkill('release', longBody(1_000));
    const totalAt = async (max: number) => {
      maxResultChars = max;
      const out = await loadSkill({ slug: 'release' }, ctx);
      expect(out.length).toBeLessThanOrEqual(max);
      return Number(/ · part 1 of (\d+)/.exec(out)?.[1]);
    };
    const at12k = await totalAt(12_000);
    const at4k = await totalAt(4_000);
    expect(at4k).toBeGreaterThan(at12k);
    // A ceiling large enough for the whole file returns it in one piece.
    maxResultChars = 100_000;
    expect(await loadSkill({ slug: 'release' }, ctx)).not.toContain('part 1 of');
  });

  it('ties parts to a version: a match passes, an edit between parts is refused', async () => {
    await writeSkill('release', longBody(1_100));
    const first = await loadSkill({ slug: 'release' }, ctx);
    const next = JSON.parse(/call skill (\{.*\}) for the next part\]$/.exec(first)![1]) as {
      part: number;
      version: string;
    };
    expect(next.part).toBe(2);
    // The footer's call, as given, works; so does the same part with no version.
    const second = await loadSkill({ slug: 'release', ...next }, ctx);
    expect(second.split('\n')[0]).toContain(`version ${next.version} · part 2 of`);
    expect(await loadSkill({ slug: 'release', part: 2 }, ctx)).toBe(second);

    // The file is edited before part 2 is asked for.
    await writeSkill('release', `New first line.\n${longBody(1_100)}`);
    const raw = await fs.readFile(path.join(root, 'release', 'SKILL.md'), 'utf8');
    const now = hashSkillContent(raw).slice(0, 12);
    await expect(loadSkill({ slug: 'release', ...next }, ctx)).rejects.toThrow(
      new RegExp(
        `^Skill 'release' changed since that part \\(now version ${now}, \\d+ parts\\)\\. Start again from part 1\\.$`
      )
    );
  });

  it('reads SKILL.md once per call, for the version and the content alike', async () => {
    await writeSkill('release', longBody(1_100));
    const spy = jest.spyOn(fs, 'readFile');
    try {
      await loadSkill({ slug: 'release', part: 2 }, ctx);
      const reads = spy.mock.calls.filter(([file]) => String(file).endsWith('SKILL.md'));
      expect(reads).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('marks a SKILL.md over 8 MB invalid without reading it', async () => {
    const file = path.join(root, 'release', 'SKILL.md');
    await fs.truncate(file, 9 * 1024 * 1024); // sparse: big on disk, no bytes written
    const spy = jest.spyOn(fs, 'readFile');
    try {
      await expect(loadSkill({ slug: 'release' }, ctx)).rejects.toThrow(
        "Skill 'release' is invalid right now: SKILL.md is over 8 MB (9 MB); Snaglet does not read files that large."
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('skill read', () => {
  it('reads a supporting file inside the skill folder', async () => {
    const out = await readSkillFile({ slug: 'release', path: 'templates/pr.md' }, ctx);
    expect(out).toBe('[Skill release · templates/pr.md]\nPR template');
  });

  it('refuses ../ escapes, absolute paths and symlinks out of the folder', async () => {
    await expect(
      readSkillFile({ slug: 'release', path: '../other/SKILL.md' }, ctx)
    ).rejects.toThrow(/outside skill 'release'/);
    await expect(readSkillFile({ slug: 'release', path: '/etc/hosts' }, ctx)).rejects.toThrow(
      'path must be relative'
    );
    await fs.symlink(path.join(root, 'other', 'SKILL.md'), path.join(root, 'release', 'link.md'));
    await expect(readSkillFile({ slug: 'release', path: 'link.md' }, ctx)).rejects.toThrow(
      /outside/
    );
  });

  it('refuses binary files and a missing file', async () => {
    await fs.writeFile(path.join(root, 'release', 'bin.dat'), Buffer.from([0, 1, 2]));
    await expect(readSkillFile({ slug: 'release', path: 'bin.dat' }, ctx)).rejects.toThrow(
      'not a text file'
    );
    await expect(readSkillFile({ slug: 'release', path: 'nope.md' }, ctx)).rejects.toThrow(
      /not found/
    );
  });

  it('refuses a supporting file over 8 MB from its size, naming the size, unread', async () => {
    const file = path.join(root, 'release', 'assets.bin');
    await fs.writeFile(file, 'text');
    await fs.truncate(file, Math.round(12.5 * 1024 * 1024));
    const spy = jest.spyOn(fs, 'readFile');
    try {
      await expect(readSkillFile({ slug: 'release', path: 'assets.bin' }, ctx)).rejects.toThrow(
        "'assets.bin' is 12.5 MB; skill files over 8 MB are not read."
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('sniffs the first 8 KB for a NUL before reading a file whole', async () => {
    const file = path.join(root, 'release', 'image.png');
    await fs.writeFile(
      file,
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.alloc(1_000_000, 0x41)])
    );
    const spy = jest.spyOn(fs, 'readFile');
    try {
      await expect(readSkillFile({ slug: 'release', path: 'image.png' }, ctx)).rejects.toThrow(
        "'image.png' is not a text file."
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    // A NUL past the sniffed bytes is still caught once the file is read.
    await fs.writeFile(path.join(root, 'release', 'late.txt'), `${'a'.repeat(9_000)}\u0000`);
    await expect(readSkillFile({ slug: 'release', path: 'late.txt' }, ctx)).rejects.toThrow(
      "'late.txt' is not a text file."
    );
  });

  it('a read part with a stale version is refused; the current one passes', async () => {
    const file = path.join(root, 'release', 'templates', 'big.md');
    await fs.writeFile(file, `${longBody(600)}\n`);
    const first = await readSkillFile({ slug: 'release', path: 'templates/big.md' }, ctx);
    const next = JSON.parse(/call skill (\{.*\}) for the next part\]$/.exec(first)![1]) as Record<
      string,
      unknown
    >;
    expect(next).toMatchObject({ op: 'read', slug: 'release', path: 'templates/big.md', part: 2 });
    await expect(readSkillFile(next, ctx)).resolves.toContain('part 2 of');
    await fs.writeFile(file, `${longBody(300)}\n`);
    await expect(readSkillFile(next, ctx)).rejects.toThrow(
      /^'templates\/big\.md' in skill 'release' changed since that part \(now version [0-9a-f]{12}, \d+ parts?\)\. Start again from part 1\.$/
    );
  });

  it('reads a long supporting file in parts whose footer names the path', async () => {
    const text = `${longBody(600)}\n`;
    await fs.writeFile(path.join(root, 'release', 'templates', 'big.md'), text);
    const version = hashSkillContent(text).slice(0, 12);
    const { results, total } = await allParts((part) =>
      readSkillFile({ slug: 'release', path: 'templates/big.md', part }, ctx)
    );
    expect(total).toBeGreaterThan(1);
    results.forEach((out, i) => {
      const n = i + 1;
      expect(out.length).toBeLessThanOrEqual(12_000);
      expect(out.split('\n')[0]).toBe(
        `[Skill release · templates/big.md · version ${version} · part ${n} of ${total}]`
      );
      const footer = `[Part ${n} of ${total} — call skill {"op":"read","slug":"release","path":"templates/big.md","part":${n + 1},"version":"${version}"} for the next part]`;
      if (n < total) expect(out.endsWith(footer)).toBe(true);
    });
    expect(results.map((out, i) => bodyOf(out, i + 1, total)).join('')).toBe(text);
    await expect(
      readSkillFile({ slug: 'release', path: 'templates/big.md', part: total + 1 }, ctx)
    ).rejects.toThrow(`'templates/big.md' in skill 'release' has ${total} parts`);
  });

  it('cuts only a single line longer than a part, and says so in the footer', async () => {
    const text = `Intro\n${'z'.repeat(30_000)}\nOutro\n`;
    await fs.writeFile(path.join(root, 'release', 'wide.md'), text);
    const { results, total } = await allParts((part) =>
      readSkillFile({ slug: 'release', path: 'wide.md', part }, ctx)
    );
    expect(total).toBeGreaterThan(2);
    // Part 1 ends on the line boundary before the long line; part 2 cuts into it.
    expect(results[0]).toMatch(/\nIntro\n\[Part 1 of \d+ — call skill/);
    expect(results[1]).toMatch(/, ends mid-line — call skill \{"op":"read"/);
    expect(results.every((out) => out.length <= 12_000)).toBe(true);
    expect(results.map((out, i) => bodyOf(out, i + 1, total)).join('')).toBe(text);
  });

  it('applies the thread check before touching the disk', async () => {
    await expect(readSkillFile({ slug: 'other', path: 'SKILL.md' }, ctx)).rejects.toThrow(
      "Skill 'other' is not available in this thread."
    );
  });
});

describe('pickSkill', () => {
  it('finds the skill by slug; a slug outside the set is not available', () => {
    const set = [row('alpha'), row('beta', { id: 'b' })];
    expect(pickSkill(set, 'beta').id).toBe('b');
    expect(() => pickSkill(set, 'gamma')).toThrow("Skill 'gamma' is not available in this thread.");
  });
});

describe('skill(op) dispatcher', () => {
  it('routes load/read and rejects unknown ops', async () => {
    await expect(tool({ op: 'load', slug: 'release' }, {}, ctx)).resolves.toContain('# Release');
    await expect(tool({ op: 'nope', slug: 'release' }, {}, ctx)).rejects.toThrow('load | read');
  });

  it('passes part through to load', async () => {
    await writeSkill('release', longBody(1_000));
    await expect(tool({ op: 'load', slug: 'release', part: 2 }, {}, ctx)).resolves.toMatch(
      /^\[Skill release · version [0-9a-f]{12} · part 2 of \d+ · /
    );
  });
});
