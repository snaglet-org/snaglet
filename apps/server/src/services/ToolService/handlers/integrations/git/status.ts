import { asNonEmptyString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { runExecFile } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';

/** A single file entry in the parsed status. */
interface StatusFile {
  /** Repo-relative path. */
  path: string;
  /** Index (staged) status code: 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '.' | '?' | '!' */
  index: string;
  /** Worktree (unstaged) status code, same domain as `index`. */
  worktree: string;
  /** For renames/copies, the original path. */
  renamed_from?: string;
  /** True if this file has merge-conflict markers. */
  conflicted?: boolean;
}

interface StatusSummary {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

interface StructuredStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  files: StatusFile[];
  summary: StatusSummary;
}

/**
 * Parse `git status --porcelain=v2 --branch` output into structured data.
 * v2 format docs: https://git-scm.com/docs/git-status#_porcelain_format_version_2
 */
function parsePorcelainV2(raw: string): StructuredStatus {
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const status: StructuredStatus = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    clean: true,
    files: [],
    summary: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  };

  for (const line of lines) {
    // Header lines: "# branch.<key> <value>"
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      status.branch = head === '(detached)' ? null : head;
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      // "# branch.ab +<ahead> -<behind>"
      const parts = line.slice('# branch.ab '.length).trim().split(/\s+/);
      for (const part of parts) {
        if (part.startsWith('+')) status.ahead = Number(part.slice(1)) || 0;
        else if (part.startsWith('-')) status.behind = Number(part.slice(1)) || 0;
      }
      continue;
    }
    if (line.startsWith('#')) continue;

    // Entry lines. First token is the entry kind.
    const kind = line[0];

    if (kind === '1') {
      // Ordinary changed entry:
      // "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      const filePath = parts.slice(8).join(' ');
      status.files.push({
        path: filePath,
        index: xy[0] ?? '.',
        worktree: xy[1] ?? '.',
      });
    } else if (kind === '2') {
      // Renamed/copied entry:
      // "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>"
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      const rest = parts.slice(9).join(' ');
      const [newPath, origPath] = rest.split('\t');
      status.files.push({
        path: newPath ?? rest,
        index: xy[0] ?? '.',
        worktree: xy[1] ?? '.',
        renamed_from: origPath,
      });
    } else if (kind === 'u') {
      // Unmerged entry:
      // "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
      const parts = line.split(' ');
      const xy = parts[1] ?? 'UU';
      const filePath = parts.slice(10).join(' ');
      status.files.push({
        path: filePath,
        index: xy[0] ?? 'U',
        worktree: xy[1] ?? 'U',
        conflicted: true,
      });
    } else if (kind === '?') {
      // Untracked: "? <path>"
      status.files.push({
        path: line.slice(2),
        index: '?',
        worktree: '?',
      });
    } else if (kind === '!') {
      // Ignored: "! <path>" — skip; not actionable for agents in normal flows.
      continue;
    }
  }

  // Compute summary.
  for (const f of status.files) {
    if (f.conflicted) status.summary.conflicted += 1;
    if (f.index === '?') status.summary.untracked += 1;
    else {
      if (f.index !== '.' && f.index !== '?') status.summary.staged += 1;
      if (f.worktree !== '.' && f.worktree !== '?') status.summary.unstaged += 1;
    }
  }
  status.clean = status.files.length === 0;

  return status;
}

/** Render a compact human-readable summary suitable for an LLM's text channel. */
function renderHumanSummary(s: StructuredStatus): string {
  const lines: string[] = [];
  const branch = s.branch ?? '(detached HEAD)';
  const trackingBits: string[] = [];
  if (s.upstream) trackingBits.push(`tracking ${s.upstream}`);
  if (s.ahead) trackingBits.push(`ahead ${s.ahead}`);
  if (s.behind) trackingBits.push(`behind ${s.behind}`);
  lines.push(
    trackingBits.length > 0 ? `On ${branch} (${trackingBits.join(', ')})` : `On ${branch}`
  );

  if (s.clean) {
    lines.push('Working tree clean.');
    return lines.join('\n');
  }

  const { staged, unstaged, untracked, conflicted } = s.summary;
  const counts: string[] = [];
  if (staged) counts.push(`${staged} staged`);
  if (unstaged) counts.push(`${unstaged} unstaged`);
  if (untracked) counts.push(`${untracked} untracked`);
  if (conflicted) counts.push(`${conflicted} conflicted`);
  lines.push(counts.join(', '));

  for (const f of s.files) {
    const marker = `${f.index}${f.worktree}`;
    const label = f.renamed_from ? `${f.renamed_from} -> ${f.path}` : f.path;
    lines.push(`  ${marker} ${label}`);
  }

  return lines.join('\n');
}

const tool: ToolHandler = async (input, _settings, context) => {
  const cwd = resolveToolCwd(asNonEmptyString(input.cwd), context);

  const result = await runExecFile('git', ['status', '--porcelain=v2', '--branch'], { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'git status failed');
  }

  const structured = parsePorcelainV2(result.stdout);
  const human = renderHumanSummary(structured);

  return {
    output: human,
    rawContent: structured,
  };
};

export default tool;
