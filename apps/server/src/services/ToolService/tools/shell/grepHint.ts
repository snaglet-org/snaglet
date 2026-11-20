import { existsSync, readdirSync, type Dirent } from 'fs';
import { isAbsolute, join, resolve, sep } from 'path';

/**
 * Agents keep running `grep -r` over apps/ or packages/, which walks
 * node_modules and runs past the yield window (or the hard timeout). When —
 * and only when — that happens, the shell result gets one corrective line.
 * Fast or non-recursive greps, `git grep` and `rg` never see it, so normal
 * calls carry no extra tokens.
 */
export const RECURSIVE_GREP_HINT =
  'Hint: this recursive grep is crawling node_modules. Use `git grep -n <pattern> -- <paths>` (tracked files only, much faster) or add `--exclude-dir=node_modules`.';

const GREP_BINARIES = new Set(['grep', 'egrep', 'fgrep']);
const COMMAND_WRAPPERS = new Set(['xargs', 'sudo', 'time', 'nice', 'env', 'command', 'exec']);

/** Split a command line into shell-ish words; quotes group, operators split. */
function tokenize(command: string): string[][] {
  const segments: string[][] = [[]];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  const push = () => {
    if (inWord) segments[segments.length - 1].push(word);
    word = '';
    inWord = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '&' || ch === '(' || ch === ')') {
      push();
      if (segments[segments.length - 1].length > 0) segments.push([]);
      continue;
    }
    word += ch;
    inWord = true;
  }
  push();
  return segments.filter((s) => s.length > 0);
}

function isRecursiveFlag(token: string): boolean {
  if (token === '--recursive' || token === '--dereference-recursive') return true;
  return /^-[A-Za-z]*[rR][A-Za-z]*$/.test(token);
}

/** grep options that take the next word as their value. */
const VALUE_FLAGS = new Set([
  '-e',
  '-f',
  '-m',
  '-A',
  '-B',
  '-C',
  '--regexp',
  '--file',
  '--include',
  '--exclude',
  '--exclude-dir',
]);

/** The path operands of a grep invocation (the pattern operand dropped). */
function searchPaths(args: string[]): string[] {
  const operands: string[] = [];
  let explicitPattern = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (VALUE_FLAGS.has(a)) {
      if (a === '-e' || a === '--regexp' || a === '-f' || a === '--file') explicitPattern = true;
      i += 1;
      continue;
    }
    if (a.startsWith('--regexp=') || a.startsWith('--file=')) explicitPattern = true;
    if (a.startsWith('-')) continue;
    operands.push(a);
  }
  return explicitPattern ? operands : operands.slice(1);
}

/**
 * Whether a recursive walk of `dir` would enter a node_modules: the dir itself
 * or one level of children (pnpm puts them in apps/<pkg>/ and packages/<pkg>/).
 * Bounded to two directory reads so the check never becomes the slow part.
 */
function hasNodeModules(dir: string): boolean {
  if (dir.split(sep).includes('node_modules')) return true;
  if (existsSync(join(dir, 'node_modules'))) return true;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(
    (e) =>
      e.isDirectory() && !e.name.startsWith('.') && existsSync(join(dir, e.name, 'node_modules'))
  );
}

/**
 * True when `command` runs a recursive grep (not `git grep`) without excluding
 * node_modules, over a tree that contains a node_modules directory: the cwd
 * itself, or any path-like argument.
 */
export function isRecursiveGrepOverNodeModules(command: string, cwd: string): boolean {
  for (const words of tokenize(command)) {
    // The command word: skip env assignments and simple wrappers (`xargs`,
    // `sudo`, `time`, ...). `git grep` lands on `git` and is never flagged.
    let at = 0;
    while (at < words.length && (/^\w+=/.test(words[at]) || COMMAND_WRAPPERS.has(words[at])))
      at += 1;
    const base = (words[at] ?? '').split('/').pop() ?? '';
    if (!GREP_BINARIES.has(base)) continue;
    const args = words.slice(at + 1);
    if (!args.some(isRecursiveFlag)) continue;
    if (args.some((a) => a.startsWith('--exclude-dir') && a.includes('node_modules'))) continue;
    if (args.some((a, i) => a === '--exclude-dir' && (args[i + 1] ?? '').includes('node_modules')))
      continue;
    const paths = searchPaths(args);
    // No path arguments: grep -r searches the cwd.
    if (
      paths.length === 0
        ? hasNodeModules(cwd)
        : paths.some((p) => hasNodeModules(isAbsolute(p) ? p : resolve(cwd, p)))
    )
      return true;
  }
  return false;
}

/**
 * The hint line for a shell result, or null. Shown only when the command was
 * slow: it yielded into a background session or was killed.
 */
export function recursiveGrepHint(input: {
  command: string;
  cwd: string;
  slow: boolean;
}): string | null {
  if (!input.slow) return null;
  return isRecursiveGrepOverNodeModules(input.command, input.cwd) ? RECURSIVE_GREP_HINT : null;
}
