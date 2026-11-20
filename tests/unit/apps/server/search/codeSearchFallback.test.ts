import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, jest } from '@jest/globals';
import { listFilesWithoutRipgrep } from '@server/services/ToolService/lib/codeSearchFallback';
import tool from '@server/services/ToolService/handlers/search/codeSearch';

let root: string;
const originalPath = process.env.PATH;
afterEach(async () => {
  jest.restoreAllMocks();
  process.env.PATH = originalPath;
  if (root) await rm(root, { recursive: true, force: true });
});

it('rejects oversized ignore files rather than ignoring their rules or allocating unbounded input', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-ignore-'));
  await writeFile(path.join(root, '.gitignore'), 'x'.repeat(1024 * 1024 + 1));
  await expect(listFilesWithoutRipgrep(root, null, 100)).rejects.toThrow(/ignore.*limit/i);
});

it('rejects traversal over its entry budget rather than returning partial rankings', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-limit-'));
  await writeFile(path.join(root, 'a.ts'), '');
  await writeFile(path.join(root, 'b.ts'), '');
  await expect(listFilesWithoutRipgrep(root, null, 1)).rejects.toThrow(/entry fallback limit/);
});

it('searches content as case-insensitive plain text and explains literal no-hits', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-content-'));
  await writeFile(path.join(root, 'sample.ts'), 'PREFIX Foo.*BAR suffix\nfoo anything bar\n');
  process.env.PATH = path.join(root, 'missing-bin');
  const result = JSON.parse(
    await tool({ query: 'foo.*bar', mode: 'content', path: root }, {}, { cwd: root })
  );
  expect(result.files).toEqual([{ path: 'sample.ts', line: 1, snippet: 'PREFIX Foo.*BAR suffix' }]);
  expect(result.notice).toBe(
    "ripgrep isn't installed, so this was searched as plain text; regex needs ripgrep."
  );
  const empty = JSON.parse(
    await tool({ query: '^absent$', mode: 'content', path: root }, {}, { cwd: root })
  );
  expect(empty.files).toEqual([]);
  expect(empty.notice).toBe(result.notice);
});

// Removing the ENOENT fallback must make this fail, independently of host rg.
it('finds and ranks names with an isolated PATH, respecting ignores and symlinks', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-fallback-'));
  await mkdir(path.join(root, '.git'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, '.gitignore'), 'ignored.ts\n');
  for (const file of ['needle.ts', 'needleExtra.ts', 'src/needle.ts', 'ignored.ts', '.needle.ts']) {
    await writeFile(path.join(root, file), 'needle');
  }
  await symlink(path.join(root, 'needle.ts'), path.join(root, 'needleLink.ts'));
  process.env.PATH = path.join(root, 'missing-bin');
  const output = await tool(
    { query: 'needle', mode: 'name', path: root, max_results: 2 },
    {},
    { cwd: root }
  );
  expect(output.startsWith('{')).toBe(true);
  expect(JSON.parse(output)).toEqual({
    basePath: root,
    files: [
      { path: 'needle.ts', line: null },
      { path: 'src/needle.ts', line: null },
    ],
  });
  expect(await tool({ query: 'ignored', mode: 'name', path: root }, {}, { cwd: root })).toContain(
    'No matches'
  );
});

it('keeps name hits and reports skipped oversized content', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-errors-'));
  await writeFile(path.join(root, 'needle.ts'), 'x'.repeat(1024 * 1024 + 1));
  process.env.PATH = path.join(root, 'missing-bin');
  const result = JSON.parse(
    await tool({ query: 'needle', mode: 'both', path: root }, {}, { cwd: root })
  );
  expect(result.files).toEqual([{ path: 'needle.ts', line: null }]);
  expect(result.error).toBeUndefined();
  expect(result.notice).toMatch(/Skipped 1 oversized file.*1MiB/);
  expect(result.notice).toContain('plain text');
});

it('honors nested ignore negation and excludes ignored directories', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-nested-'));
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'excluded'));
  await writeFile(path.join(root, '.gitignore'), '*.ts\nexcluded/\n');
  await writeFile(path.join(root, 'src/.gitignore'), '!keep.ts\n');
  for (const file of ['src/keep.ts', 'src/drop.ts', 'excluded/keep.js'])
    await writeFile(path.join(root, file), '');
  expect(await listFilesWithoutRipgrep(root, null, 100)).toEqual([path.join(root, 'src/keep.ts')]);
});

it('rejects a symlink search root rather than following it', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-linkroot-'));
  await mkdir(path.join(root, 'target'));
  await symlink(path.join(root, 'target'), path.join(root, 'alias'));
  await expect(listFilesWithoutRipgrep(path.join(root, 'alias'), null, 100)).rejects.toThrow(
    /symlink/
  );
});

it('reports name enumeration bounds as a structured failure', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-name-bound-'));
  await writeFile(path.join(root, '.gitignore'), 'x'.repeat(65537));
  process.env.PATH = path.join(root, 'missing-bin');
  const result = JSON.parse(
    await tool({ query: 'needle', mode: 'name', path: root }, {}, { cwd: root })
  );
  expect(result.files).toEqual([]);
  expect(result.error).toMatch(/ignore.*limit/i);
});

it('stops traversal at its cooperative deadline', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-deadline-'));
  const clock = jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(10001);
  try {
    await expect(listFilesWithoutRipgrep(root, null, 100)).rejects.toThrow(/time limit/);
  } finally {
    clock.mockRestore();
  }
});

// Known difference: `rg` as called has no `-i`, so with ripgrep installed
// content search is case-sensitive, while this Node fallback is
// case-insensitive (the search tool has no case option). Adding `-i` to `rg`
// would change the main search path, so it is deliberately not done.
it('fallback matches Needle, needle and NEEDLE case-insensitively', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-case-'));
  await writeFile(path.join(root, 'sample.ts'), 'Needle\nneedle\nNEEDLE\nunrelated\n');
  process.env.PATH = path.join(root, 'missing-bin');
  const expected = [
    { path: 'sample.ts', line: 1, snippet: 'Needle' },
    { path: 'sample.ts', line: 2, snippet: 'needle' },
    { path: 'sample.ts', line: 3, snippet: 'NEEDLE' },
  ];
  for (const query of ['Needle', 'needle', 'NEEDLE']) {
    const result = JSON.parse(
      await tool({ query, mode: 'content', path: root }, {}, { cwd: root })
    );
    expect(result.notice).toContain('plain text');
    expect(result.files).toEqual(expected);
  }
});

it('skips oversized files and continues to later matches with an accurate warning', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-size-'));
  for (const name of ['a.ts', 'b.ts'])
    await writeFile(path.join(root, name), 'needle' + 'x'.repeat(1024 * 1024));
  await writeFile(path.join(root, 'z.ts'), 'needle');
  process.env.PATH = path.join(root, 'missing-bin');
  const result = JSON.parse(
    await tool({ query: 'needle', mode: 'content', path: root }, {}, { cwd: root })
  );
  expect(result.error).toBeUndefined();
  expect(result.files).toEqual([{ path: 'z.ts', line: 1, snippet: 'needle' }]);
  expect(result.notice).toMatch(/Skipped 2 oversized files.*1MiB/);
});

it('discards all matches from a file that grows beyond the cap after stat', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-growth-'));
  const growing = path.join(root, 'a.ts');
  await writeFile(growing, 'needle\n' + 'x'.repeat(1024 * 1024));
  await writeFile(path.join(root, 'z.ts'), 'needle');
  const open = fs.open;
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === growing) {
      const stat = await handle.stat();
      stat.size = 1; // Snapshot before growth; the real read observes the larger file.
      jest.spyOn(handle, 'stat').mockResolvedValue(stat);
    }
    return handle;
  });
  process.env.PATH = path.join(root, 'missing-bin');
  const result = JSON.parse(
    await tool({ query: 'needle', mode: 'content', path: root }, {}, { cwd: root })
  );
  expect(result.error).toBeUndefined();
  expect(result.files).toEqual([{ path: 'z.ts', line: 1, snippet: 'needle' }]);
  expect(result.notice).toMatch(/Skipped 1 oversized file.*1MiB/);
});

it('searches files exactly at the cap and still surfaces the total read bound', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-total-'));
  const content = 'needle\n' + 'x'.repeat(1024 * 1024 - 7);
  await writeFile(path.join(root, 'a.ts'), content);
  process.env.PATH = path.join(root, 'missing-bin');
  const first = JSON.parse(
    await tool({ query: 'needle', mode: 'content', path: root }, {}, { cwd: root })
  );
  expect(first.files).toEqual([{ path: 'a.ts', line: 1, snippet: 'needle' }]);
  expect(first.notice).not.toContain('Skipped');
  for (let i = 0; i < 16; i++) await writeFile(path.join(root, `file${i}.ts`), content);
  const bounded = JSON.parse(
    await tool({ query: 'needle', mode: 'content', path: root }, {}, { cwd: root })
  );
  expect(bounded.error).toContain('16MiB total read limit');
  expect(bounded.files).toEqual([]);
});
