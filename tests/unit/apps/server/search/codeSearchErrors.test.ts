import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, jest } from '@jest/globals';

let mockError: Error & { code?: string | number };
const mockExecutables: string[] = [];
jest.mock('child_process', () => ({
  execFile: (exe: string, _args: string[], _opts: unknown, callback: (error: Error) => void) => {
    mockExecutables.push(exe);
    callback(mockError);
  },
}));
import tool from '@server/services/ToolService/handlers/search/codeSearch';
import { ripgrepExecutable } from '@server/services/ToolService/lib/ripgrepExecutable';
let root: string;
const originalRipgrepPath = process.env.SNAGLET_RIPGREP_PATH;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (originalRipgrepPath === undefined) delete process.env.SNAGLET_RIPGREP_PATH;
  else process.env.SNAGLET_RIPGREP_PATH = originalRipgrepPath;
  mockExecutables.length = 0;
});
it('executes real Node name/content fallback on mocked ENOENT', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-mock-'));
  await writeFile(path.join(root, 'needle.ts'), 'Needle');
  mockError = Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' });
  const result = JSON.parse(
    await tool({ query: 'needle', mode: 'both', path: root }, {}, { cwd: root })
  );
  expect(result.files).toEqual([
    { path: 'needle.ts', line: null },
    { path: 'needle.ts', line: 1, snippet: 'Needle' },
  ]);
  expect(result.notice).toContain('plain text');
});
it.each([
  ['invalid regex', 2],
  ['permission denied', 'EACCES'],
  ['timeout', 'ETIMEDOUT'],
] as const)('reports %s without entering fallback', async (message, code) => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-error-'));
  await writeFile(path.join(root, 'needle.ts'), 'needle');
  mockError = Object.assign(new Error(message), { code });
  const result = JSON.parse(
    await tool({ query: 'needle', mode: 'both', path: root }, {}, { cwd: root })
  );
  expect(result.files).toEqual([]);
  expect(result.error).toContain(message);
  expect(result.notice).toBeUndefined();
});
it('treats rg exit 1 as normal no matches, never as missing executable', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-empty-'));
  await writeFile(path.join(root, 'needle.ts'), 'needle');
  mockError = Object.assign(new Error('no matches'), { code: 1 });
  expect(await tool({ query: 'needle', mode: 'both', path: root }, {}, { cwd: root })).toBe(
    'No matches found for query: needle'
  );
});

it('runs the bundled ripgrep for name and content search when SNAGLET_RIPGREP_PATH exists', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet code bundled '));
  const bundled = path.join(root, 'rg');
  await writeFile(bundled, '');
  process.env.SNAGLET_RIPGREP_PATH = bundled;
  expect(ripgrepExecutable()).toBe(bundled);
  mockError = Object.assign(new Error('no matches'), { code: 1 });
  await tool({ query: 'needle', mode: 'both', path: root }, {}, { cwd: root });
  expect(mockExecutables).toEqual([bundled, bundled]);
});

it('falls back to rg on PATH when SNAGLET_RIPGREP_PATH is unset or missing', async () => {
  delete process.env.SNAGLET_RIPGREP_PATH;
  expect(ripgrepExecutable()).toBe('rg');
  process.env.SNAGLET_RIPGREP_PATH = '   ';
  expect(ripgrepExecutable()).toBe('rg');
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-code-missing-'));
  process.env.SNAGLET_RIPGREP_PATH = path.join(root, 'rg', 'rg');
  expect(ripgrepExecutable()).toBe('rg');
  // A directory is not an executable either.
  process.env.SNAGLET_RIPGREP_PATH = root;
  expect(ripgrepExecutable()).toBe('rg');
});
