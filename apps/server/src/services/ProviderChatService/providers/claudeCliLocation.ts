/**
 * Where the Claude Code CLI lives.
 *
 * A desktop app launched from Finder does not inherit the shell PATH, so a CLI
 * that runs fine in a terminal can be invisible to Snaglet. Both callers (the
 * version check and `claude auth login`) share this list: the PATH lookup
 * first, then the places the official installers put the binary.
 */

import { accessSync, constants, statSync } from 'fs';
import { homedir } from 'os';
import { delimiter, isAbsolute, join } from 'path';
import { buildCommandEnv } from '@server/services/ToolService/lib/buildSafeEnv';

/** The CLI binary; an absolute path can be pinned for packaged installs. */
function claudeCliCommand(): string {
  return process.env.SNAGLET_CLAUDE_CLI_PATH || 'claude';
}

/** Every command worth trying, in order. */
export function claudeCliCandidates(): string[] {
  const home = homedir();
  return [
    ...new Set([
      claudeCliCommand(),
      join(home, '.claude', 'local', 'claude'),
      join(home, '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ]),
  ];
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A bare name is looked up on the PATH the child will get; a path is checked as given. */
function locate(command: string, pathValue: string | undefined): string | null {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return isExecutableFile(command) ? command : null;
  }
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The command to spawn: the first candidate that exists. When none does, the
 * first candidate is returned so the spawn fails with ENOENT and the caller
 * reports a missing CLI.
 */
export function resolveClaudeCliCommand(): string {
  const candidates = claudeCliCandidates();
  const pathValue = buildCommandEnv().PATH;
  for (const candidate of candidates) {
    const found = locate(candidate, pathValue);
    if (found) return found;
  }
  return candidates[0];
}
