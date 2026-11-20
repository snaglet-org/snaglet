import { asNonEmptyString } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { runExecFile } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import { gitOperand } from './gitArgs';

interface VerifyResult {
  ref: string;
  exists: boolean;
  resolved?: {
    sha: string;
    shortSha: string;
    subject: string;
    author: string;
    authorEmail: string;
    authorDate: string;
    committerDate: string;
    parents: string[];
  };
  branchesContaining?: string[];
  remoteContains?: { remote: string; refs: string[] } | { remote: string; error: string };
  error?: string;
}

const tool: ToolHandler = async (input, _settings, context) => {
  const rawRef = asNonEmptyString(input.ref);
  if (!rawRef) throw new Error('ref is required');
  // No --end-of-options here: rev-parse only learned it in newer git, and the
  // `^{commit}` suffix already keeps a non-dash ref from reading as a flag.
  const ref = gitOperand('ref', rawRef);

  const cwd = resolveToolCwd(asNonEmptyString(input.cwd), context);
  const checkRemote = input.checkRemote === true;

  const result: VerifyResult = { ref, exists: false };

  const revParse = await runExecFile('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd,
  });

  if (revParse.code !== 0) {
    result.exists = false;
    result.error =
      revParse.stderr.trim() || `Ref "${ref}" does not resolve to any commit in ${cwd}.`;
    return JSON.stringify(result, null, 2);
  }

  const sha = revParse.stdout.trim();
  result.exists = true;

  // Step 2: pull the commit metadata using a structured format we can parse safely.
  // Use a unique delimiter unlikely to appear in commit messages.
  const FIELD = '\u0001';
  const RECORD = '\u0002';
  const format = ['%H', '%h', '%s', '%an', '%ae', '%aI', '%cI', '%P'].join(FIELD) + RECORD;

  const show = await runExecFile('git', ['log', '-1', '--no-walk', `--format=${format}`, sha], {
    cwd,
  });

  if (show.code !== 0) {
    result.error = show.stderr.trim() || 'git log failed after rev-parse succeeded';
    return JSON.stringify(result, null, 2);
  }

  const record = show.stdout.split(RECORD)[0];
  const fields = record.split(FIELD);
  if (fields.length >= 8) {
    result.resolved = {
      sha: fields[0],
      shortSha: fields[1],
      subject: fields[2],
      author: fields[3],
      authorEmail: fields[4],
      authorDate: fields[5],
      committerDate: fields[6],
      parents: fields[7].trim() ? fields[7].trim().split(' ') : [],
    };
  }

  const branches = await runExecFile(
    'git',
    ['branch', '--contains', sha, '--format=%(refname:short)'],
    { cwd }
  );
  if (branches.code === 0) {
    result.branchesContaining = branches.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  if (checkRemote) {
    const remoteName = 'origin';
    const fetch = await runExecFile('git', ['fetch', remoteName, '--quiet'], { cwd });
    if (fetch.code !== 0) {
      result.remoteContains = {
        remote: remoteName,
        error: fetch.stderr.trim() || 'fetch failed',
      };
    } else {
      const remoteBranches = await runExecFile(
        'git',
        ['branch', '-r', '--contains', sha, '--format=%(refname:short)'],
        { cwd }
      );
      const refs =
        remoteBranches.code === 0
          ? remoteBranches.stdout
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
          : [];
      result.remoteContains = { remote: remoteName, refs };
    }
  }

  return JSON.stringify(result, null, 2);
};

export default tool;
