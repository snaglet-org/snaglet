import { asNonEmptyString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { runExecFile } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import { END_OF_OPTIONS, optionalGitOperand } from './gitArgs';

interface DiffFileStat {
  /** Repo-relative path of the changed file (post-rename if applicable). */
  path: string;
  /** Lines added. `null` for binary files. */
  additions: number | null;
  /** Lines removed. `null` for binary files. */
  deletions: number | null;
  /** True if git reports this as a binary diff (numstat shows '-\t-'). */
  binary: boolean;
  /** For renames, the path before the rename. */
  renamed_from?: string;
}

interface StructuredDiff {
  /** What this diff is comparing. */
  mode: 'unstaged' | 'staged' | 'commit';
  /** When mode === 'commit', the ref being compared against. */
  commit?: string;
  /** Path filter, if one was applied. */
  path?: string;
  /** Per-file change summary (from `git diff --numstat`). */
  files: DiffFileStat[];
  /** Totals across all files. Binary files are excluded from line counts. */
  totals: {
    files_changed: number;
    additions: number;
    deletions: number;
  };
  /** Full unified diff text. Omitted when `stat: true` was requested. */
  patch?: string;
  /** `--stat` summary text. Present only when `stat: true` was requested. */
  stat?: string;
}

function parseNumstat(raw: string): DiffFileStat[] {
  const files: DiffFileStat[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    // Format: "<add>\t<del>\t<path>" or "-\t-\t<path>" for binary.
    // Renames render as "<add>\t<del>\t<oldPath> => <newPath>" or with brace notation.
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addsRaw, delsRaw, pathRaw] = parts;
    const binary = addsRaw === '-' && delsRaw === '-';
    const additions = binary ? null : Number(addsRaw);
    const deletions = binary ? null : Number(delsRaw);

    let filePath = pathRaw;
    let renamedFrom: string | undefined;
    // Rename syntax: "old => new" or "prefix/{old => new}/suffix".
    const braceMatch = pathRaw.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
    if (braceMatch) {
      const [, prefix, oldMid, newMid, suffix] = braceMatch;
      renamedFrom = `${prefix}${oldMid}${suffix}`.replace(/\/+/g, '/');
      filePath = `${prefix}${newMid}${suffix}`.replace(/\/+/g, '/');
    } else {
      const arrowIdx = pathRaw.indexOf(' => ');
      if (arrowIdx >= 0) {
        renamedFrom = pathRaw.slice(0, arrowIdx);
        filePath = pathRaw.slice(arrowIdx + 4);
      }
    }

    files.push({
      path: filePath,
      additions,
      deletions,
      binary,
      ...(renamedFrom ? { renamed_from: renamedFrom } : {}),
    });
  }
  return files;
}

/**
 * Build one `git diff` argv. Flags come first; a caller-supplied commit is
 * placed after `--end-of-options` and a path after `--`, so neither can be
 * parsed as an option (`--output=<file>` would otherwise overwrite a file).
 */
function buildDiffArgs(input: {
  staged: boolean;
  commit?: string;
  target?: string;
  flags: string[];
}): string[] {
  const args: string[] = ['diff'];
  if (input.staged) args.push('--cached');
  args.push(...input.flags);
  if (!input.staged && input.commit) args.push(END_OF_OPTIONS, input.commit);
  if (input.target) args.push('--', input.target);
  return args;
}

const tool: ToolHandler = async (input, _settings, context) => {
  const cwd = resolveToolCwd(asNonEmptyString(input.cwd), context);
  const staged = input.staged === true;
  const stat = input.stat === true;
  const commit = optionalGitOperand('commit', asNonEmptyString(input.commit)) ?? undefined;
  const target = asNonEmptyString(input.path) ?? undefined;

  const mode: StructuredDiff['mode'] = staged ? 'staged' : commit ? 'commit' : 'unstaged';
  const usedCommit = mode === 'commit' ? commit : undefined;

  // Always run numstat for the structured per-file summary.
  const numstatArgs = buildDiffArgs({ staged, commit, target, flags: ['--numstat'] });
  const numstatResult = await runExecFile('git', numstatArgs, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (numstatResult.code !== 0) {
    throw new Error(numstatResult.stderr.trim() || 'git diff --numstat failed');
  }
  const files = parseNumstat(numstatResult.stdout);

  // Then run the requested view: --stat summary, or full patch.
  const viewArgs = buildDiffArgs({ staged, commit, target, flags: stat ? ['--stat'] : [] });
  const viewResult = await runExecFile('git', viewArgs, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (viewResult.code !== 0) {
    throw new Error(viewResult.stderr.trim() || 'git diff failed');
  }
  const viewText = viewResult.stdout.trim();

  const totals = files.reduce(
    (acc, f) => {
      acc.files_changed += 1;
      acc.additions += f.additions ?? 0;
      acc.deletions += f.deletions ?? 0;
      return acc;
    },
    { files_changed: 0, additions: 0, deletions: 0 }
  );

  const structured: StructuredDiff = {
    mode,
    ...(usedCommit ? { commit: usedCommit } : {}),
    ...(target ? { path: target } : {}),
    files,
    totals,
    ...(stat ? { stat: viewText } : { patch: viewText }),
  };

  const human =
    viewText.length > 0
      ? viewText
      : files.length === 0
        ? 'No differences.'
        : `${totals.files_changed} file(s) changed, +${totals.additions} / -${totals.deletions}`;

  return {
    output: human,
    rawContent: structured,
  };
};

export default tool;
