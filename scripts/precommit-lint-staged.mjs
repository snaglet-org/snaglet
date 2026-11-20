import { spawnSync } from 'node:child_process';
import crossSpawn from 'cross-spawn';

function fail(message) {
  console.error(`pre-commit: ${message}`);
  process.exit(1);
}

function splitNul(buffer) {
  const paths = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) paths.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start < buffer.length) paths.push(buffer.subarray(start));
  return paths;
}

function gitPaths(args) {
  const result = spawnSync('git', args, {
    encoding: null,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) fail(`could not run git: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
  return splitNul(result.stdout);
}

const workTree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
if (workTree.error) fail(`could not run git: ${workTree.error.message}`);
if (workTree.status !== 0) process.exit(workTree.status ?? 1);

const stagedPaths = gitPaths(['diff', '--no-ext-diff', '--cached', '--name-only', '-z', '--']);
const unstagedPaths = gitPaths(['diff', '--no-ext-diff', '--name-only', '-z', '--']);
const unstagedKeys = new Set(unstagedPaths.map((path) => path.toString('hex')));
const partiallyStaged = stagedPaths.filter((path) => unstagedKeys.has(path.toString('hex')));

if (partiallyStaged.length > 0) {
  console.error(
    'pre-commit: refusing to format partially staged files. Stage each file completely or unstage it:'
  );
  for (const path of partiallyStaged) console.error(`  ${JSON.stringify(path.toString('utf8'))}`);
  process.exit(1);
}

const lintStaged = crossSpawn.sync('pnpm', ['exec', 'lint-staged', '--no-stash'], {
  stdio: 'inherit',
  windowsHide: true,
});
if (lintStaged.error) fail(`could not run lint-staged: ${lintStaged.error.message}`);
process.exit(lintStaged.status ?? 1);
