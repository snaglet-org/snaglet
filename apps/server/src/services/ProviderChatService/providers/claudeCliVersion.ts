/**
 * The Claude Code CLI version Snaglet presents when it speaks as Claude Code.
 *
 * Pro/Max OAuth requests carry `User-Agent: claude-cli/<version>`, and
 * Anthropic gates newer models on that version: a stale string gets a 400
 * "Claude Code <v> does not support this model" even when the installed CLI is
 * current. So the version comes from the installed CLI (`claude --version`,
 * fixed argv, no shell), is cached, and falls back to a known-recent constant
 * when the CLI cannot be found or does not answer in time.
 */

import { execFile } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { buildCommandEnv } from '@server/services/ToolService/lib/buildSafeEnv';

/** Presented when no installed CLI answers. Keep it at a recent release. */
export const CLAUDE_CLI_FALLBACK_VERSION = '2.1.285';

/** One `claude --version` call. */
const VERSION_EXEC_TIMEOUT_MS = 3_000;
/** A request never waits longer than this for the first detection. */
const FIRST_DETECTION_WAIT_MS = 4_000;
/** A detected version is refreshed after this, so `claude update` is picked up. */
const DETECTED_TTL_MS = 60 * 60 * 1000;
/** A failed detection is retried sooner. */
const FALLBACK_TTL_MS = 5 * 60 * 1000;

export interface ClaudeCliVersionInfo {
  version: string;
  /** `detected` from an installed CLI, or the `fallback` constant. */
  source: 'detected' | 'fallback';
}

/** The CLI binary; an absolute path can be pinned for packaged installs. */
function claudeCliCommand(): string {
  return process.env.SNAGLET_CLAUDE_CLI_PATH || 'claude';
}

/**
 * Where to look. A desktop app launched from Finder does not inherit the
 * shell PATH, so the installer locations are tried after the PATH lookup.
 */
function candidateCommands(): string[] {
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

/** `2.1.285 (Claude Code)` → `2.1.285`; null when no semver is present. */
export function parseClaudeCliVersion(output: string): string | null {
  const match = /(?<![\d.])(\d+\.\d+\.\d+)(?![\d.])/.exec(output);
  return match?.[1] ?? null;
}

/**
 * Candidates include files in the user's home that an agent can replace, so the CLI gets
 * buildCommandEnv(), never the server's own environment.
 */
function runVersion(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      ['--version'],
      { timeout: VERSION_EXEC_TIMEOUT_MS, windowsHide: true, env: buildCommandEnv() },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout)))
    );
  });
}

async function detect(): Promise<ClaudeCliVersionInfo> {
  for (const command of candidateCommands()) {
    try {
      const version = parseClaudeCliVersion(await runVersion(command));
      if (version) {
        logger.info(`[claude-cli] presenting Claude Code ${version} (from ${command})`);
        return { version, source: 'detected' };
      }
    } catch (err) {
      logger.debug(`[claude-cli] ${command} --version failed: ${getErrorMessage(err)}`);
    }
  }
  logger.warn(
    `[claude-cli] no Claude Code CLI answered --version; presenting ${CLAUDE_CLI_FALLBACK_VERSION}. ` +
      'Set SNAGLET_CLAUDE_CLI_PATH to the claude binary if it is installed somewhere else.'
  );
  return { version: CLAUDE_CLI_FALLBACK_VERSION, source: 'fallback' };
}

let cached: (ClaudeCliVersionInfo & { at: number }) | null = null;
let inflight: Promise<ClaudeCliVersionInfo> | null = null;
/** Bumped by `forgetClaudeCliVersion` so a detection started before it cannot land. */
let generation = 0;

function isFresh(entry: ClaudeCliVersionInfo & { at: number }, now: number): boolean {
  const ttl = entry.source === 'detected' ? DETECTED_TTL_MS : FALLBACK_TTL_MS;
  return now - entry.at < ttl;
}

function refresh(): Promise<ClaudeCliVersionInfo> {
  if (inflight) return inflight;
  const started = generation;
  const run: Promise<ClaudeCliVersionInfo> = detect()
    .then((info) => {
      if (started === generation) cached = { ...info, at: Date.now() };
      return info;
    })
    .finally(() => {
      if (inflight === run) inflight = null;
    });
  inflight = run;
  return run;
}

/**
 * The version to present. A stale cached value is served while a refresh runs
 * in the background; with nothing cached the caller waits at most
 * FIRST_DETECTION_WAIT_MS and then gets the fallback.
 */
export async function getClaudeCliVersion(): Promise<ClaudeCliVersionInfo> {
  const now = Date.now();
  if (cached && isFresh(cached, now)) return { version: cached.version, source: cached.source };
  const pending = refresh();
  if (cached) return { version: cached.version, source: cached.source };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = new Promise<ClaudeCliVersionInfo>((resolve) => {
    timer = setTimeout(
      () => resolve({ version: CLAUDE_CLI_FALLBACK_VERSION, source: 'fallback' }),
      FIRST_DETECTION_WAIT_MS
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([pending, fallback]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Drop the cached version so the next request re-reads the installed CLI. */
export function forgetClaudeCliVersion(): void {
  generation += 1;
  cached = null;
  inflight = null;
}

const VERSION_REJECTION_RE = /Claude Code\s+v?[\d.]+\s+does not support this model/i;

/** Anthropic's 400 for a `claude-cli/<v>` identity too old for the requested model. */
export function isClaudeCodeVersionRejection(message: string): boolean {
  return VERSION_REJECTION_RE.test(message) || /run\s+`?claude update`?/i.test(message);
}

/**
 * Snaglet's copy for that rejection. Anthropic's own text says "run `claude
 * update`", which is wrong when the installed CLI is already current and Snaglet
 * simply could not find it.
 */
export function claudeCodeVersionRejectionMessage(
  modelId: string,
  presented: ClaudeCliVersionInfo | null
): string {
  const version = presented?.version ?? 'unknown';
  if (presented?.source === 'fallback') {
    return (
      `Anthropic refused ${modelId} for this Claude Code sign-in: Snaglet could not find the Claude ` +
      `Code CLI, so it identified as version ${version}, which predates this model. Make sure ` +
      '`claude --version` works in a terminal (or set SNAGLET_CLAUDE_CLI_PATH to the claude binary ' +
      'and restart Snaglet), or switch this agent to an Anthropic API key.'
    );
  }
  return (
    `Anthropic refused ${modelId} for this Claude Code sign-in: the installed Claude Code CLI ` +
    `(${version}) predates this model. Run \`claude update\` in a terminal, then send again — ` +
    'Snaglet re-reads the installed version automatically.'
  );
}
