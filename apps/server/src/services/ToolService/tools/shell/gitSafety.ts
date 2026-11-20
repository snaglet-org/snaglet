import { stdinCommandLines } from './stdinLines';
/**
 * Git-safety rail for shell(op:run).
 *
 * Agents share a working tree with humans and other agents. A handful of git
 * commands either throw away work that is not theirs (stash, reset --hard,
 * clean -f, checkout -- <path>, …) or open an editor / prompt that a
 * pipe-backed shell cannot answer (add -p, rebase -i, commit without -m).
 * This refuses them before anything is spawned, with one sentence naming the
 * alternative.
 *
 * A rail against mistakes, not a sandbox: `eval`, aliases and scripts are out
 * of scope. Pure function so the matrix can be unit-tested exhaustively.
 */

const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash']);
const PREFIX_WORDS = new Set(['env', 'command', 'sudo', 'exec', 'nohup', 'time']);
/** git global options that take a separate value argument. */
const GLOBAL_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

const ASK = 'ask the user to do it';

/**
 * Split a command line into simple-command segments on `;` `&` `|` newline,
 * `$(`, `(`, `)` and backticks, outside quotes. Quoted text stays intact, so
 * `sh -c 'a && b'` remains one segment whose script is inspected separately.
 */
function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let k = 0; k < cmd.length; k++) {
    const ch = cmd.charAt(k);
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && k + 1 < cmd.length) cur += cmd.charAt(++k);
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (';&|\n()`'.includes(ch) || (ch === '$' && cmd[k + 1] === '(')) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Minimal shell-word split: honors single/double quotes, drops them. */
function words(segment: string): string[] {
  const out: string[] = [];
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

const has = (args: string[], ...flags: string[]) => args.some((a) => flags.includes(a));
/**
 * Short-flag cluster check: `-fd`, `-xf` and `-fdx` all contain `f`. `-X<opt>`
 * (a strategy option such as `-Xtheirs`) is a value, not a cluster.
 */
const hasShort = (args: string[], letter: string) =>
  args.some((a) => /^-[a-zA-Z]+$/.test(a) && !a.startsWith('-X') && a.includes(letter));

function refuseGit(sub: string, args: string[]): string | null {
  switch (sub) {
    case 'stash': {
      const action = args.find((a) => !a.startsWith('-'));
      if (action === 'list' || action === 'show') return null;
      return `Refused: \`git stash\` moves other people's uncommitted work out of the shared tree. Commit or copy your own files instead, or ${ASK}.`;
    }
    case 'reset':
      if (has(args, '--hard', '--merge', '--keep')) {
        return `Refused: \`git reset --hard\` discards uncommitted work in the shared tree. Use \`git reset\` (unstage only) or revert your own files with plain edits.`;
      }
      return null;
    case 'clean':
      if (has(args, '--force') || hasShort(args, 'f')) {
        return `Refused: \`git clean -f\` deletes untracked files that may belong to others. Run \`git clean -n\` to list them and remove only your own files.`;
      }
      return null;
    case 'checkout':
      if (has(args, '-p', '--patch')) {
        return `Refused: \`git checkout -p\` is interactive and this shell is not a TTY. Revert your own files with plain edits.`;
      }
      if (has(args, '--force') || hasShort(args, 'f')) {
        return `Refused: \`git checkout -f\` discards uncommitted changes that may belong to others. Commit your own work first, or ${ASK}.`;
      }
      if (has(args, '--', '.')) {
        return `Refused: \`git checkout -- <path>\` discards uncommitted changes that may belong to others. Revert your own files with plain edits, or ${ASK}.`;
      }
      return null;
    case 'switch':
      if (has(args, '--discard-changes', '--force') || hasShort(args, 'f')) {
        return `Refused: \`git switch --discard-changes\` throws away uncommitted changes that may belong to others. Commit your own work first, or ${ASK}.`;
      }
      return null;
    case 'restore':
      if (has(args, '-p', '--patch')) {
        return `Refused: \`git restore -p\` is interactive and this shell is not a TTY. Revert your own files with plain edits.`;
      }
      if (has(args, '--staged', '-S') && !has(args, '--worktree', '-W')) return null;
      return `Refused: \`git restore\` discards uncommitted changes that may belong to others. Use \`git restore --staged\` to unstage, or revert your own files with plain edits.`;
    case 'add':
      if (has(args, '-p', '--patch', '-i', '--interactive', '-e', '--edit')) {
        return `Refused: \`git add -p\` is interactive and this shell is not a TTY. Stage explicit paths instead (\`git add <file>\`).`;
      }
      return null;
    case 'rebase':
      if (has(args, '--interactive') || hasShort(args, 'i')) {
        return `Refused: \`git rebase -i\` opens an editor and this shell is not a TTY. ${ASK.charAt(0).toUpperCase()}${ASK.slice(1)}.`;
      }
      return null;
    case 'commit': {
      // --fixup=amend:/reword: open an editor; a plain --fixup <sha> does not.
      const fixupIdx = args.findIndex((a) => a === '--fixup' || a.startsWith('--fixup='));
      const fixupArg = fixupIdx < 0 ? undefined : args[fixupIdx];
      const fixupValue =
        fixupArg === undefined
          ? undefined
          : fixupArg.includes('=')
            ? fixupArg.slice('--fixup='.length)
            : args[fixupIdx + 1];
      const plainFixup = fixupValue !== undefined && !/^(amend|reword):/.test(fixupValue);
      if (
        !plainFixup &&
        !has(args, '-m', '--message', '-F', '--file', '-C', '--reuse-message', '--no-edit') &&
        !args.some(
          (a) => a.startsWith('--message=') || a.startsWith('--file=') || /^-[a-zA-Z]*m/.test(a)
        )
      ) {
        return `Refused: \`git commit\` without \`-m\` opens an editor and this shell is not a TTY. Pass the message with \`-m "…"\` (or \`--no-edit\`).`;
      }
      return null;
    }
    case 'push':
      // --force-if-includes only modifies --force-with-lease; on its own it is
      // a no-op and is allowed. Next to a force flag, that flag refuses.
      if (
        has(args, '--force', '--force-with-lease', '--mirror') ||
        hasShort(args, 'f') ||
        args.some((a) => a.startsWith('--force-with-lease=') || /^\+/.test(a))
      ) {
        return `Refused: \`git push --force\` rewrites shared history. Push normally, or ${ASK}.`;
      }
      return null;
    case 'branch':
      if (has(args, '-D') || (has(args, '-d', '--delete') && has(args, '-f', '--force'))) {
        return `Refused: \`git branch -D\` deletes a branch even if its work is unmerged. Use \`git branch -d\`, or ${ASK}.`;
      }
      return null;
    default:
      return null;
  }
}

function refuseSegment(segment: string, depth: number): string | null {
  let w = words(segment.trim());
  // Strip leading VAR=value assignments and wrapper words.
  let first = w[0];
  while (
    first !== undefined &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || PREFIX_WORDS.has(first))
  ) {
    w = w.slice(1);
    first = w[0];
  }
  if (first === undefined) return null;
  const head = first.replace(/^\\/, '').split('/').pop() ?? '';

  // Look inside `sh -c '<script>'` once.
  if (SHELL_WRAPPERS.has(head) && depth === 0) {
    const ci = w.findIndex((a) => /^-[a-z]*c$/.test(a));
    const script = ci >= 0 ? w[ci + 1] : undefined;
    if (script !== undefined) return gitRefusal(script, depth + 1);
    return null;
  }
  if (head !== 'git') return null;

  let i = 1;
  for (let opt = w[i]; opt !== undefined && opt.startsWith('-'); opt = w[i]) {
    i += GLOBAL_OPTS_WITH_VALUE.has(opt) ? 2 : 1;
  }
  const sub = w[i];
  if (sub === undefined) return null;
  return refuseGit(sub, w.slice(i + 1));
}

/**
 * The same rail for text typed into a running session (`shell(op:write)`):
 * each complete or partial line is checked as its own command line.
 */
export function gitRefusalForStdin(chars: string, pending = ''): string | null {
  for (const line of stdinCommandLines(pending, chars).lines) {
    const refusal = gitRefusal(line);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * Returns a one-sentence refusal when `cmd` contains a destructive or
 * interactive git command, otherwise null.
 */
export function gitRefusal(cmd: string, depth = 0): string | null {
  for (const segment of segments(cmd)) {
    const refusal = refuseSegment(segment, depth);
    if (refusal) return refusal;
  }
  return null;
}
