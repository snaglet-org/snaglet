/**
 * hostMachine — one line describing the computer Snaglet runs on.
 *
 * Constant for the life of the process (OS, CPU, installed RAM, default
 * shell), so it is safe in the cached system prefix. Nothing live goes here —
 * no free memory, load or uptime — or the prefix would change between turns.
 * Memoized for the same reason.
 */

import os from 'node:os';
import path from 'node:path';

const GIB = 1024 ** 3;

function computerKind(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'darwin') return arch === 'arm64' ? 'Mac (Apple Silicon)' : 'Mac (Intel)';
  if (platform === 'win32') return 'Windows PC';
  if (platform === 'linux') return 'Linux machine';
  return 'computer';
}

function osName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}

function shellName(platform: NodeJS.Platform): string | null {
  const raw = platform === 'win32' ? process.env.COMSPEC : process.env.SHELL;
  const name = raw ? path.basename(raw).replace(/\.exe$/i, '') : '';
  return name || null;
}

/** Build the line from explicit inputs, so tests need no real machine. */
export function formatHostMachine(input: {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  cpuModel: string | null;
  cpuCount: number;
  totalMemBytes: number;
  shell: string | null;
}): string {
  const cpu = input.cpuModel?.replace(/\s+/g, ' ').trim();
  const cores = `${input.cpuCount} core${input.cpuCount === 1 ? '' : 's'}`;
  const chip = cpu ? `${cpu}, ${cores}` : cores;
  const ram = Math.max(1, Math.round(input.totalMemBytes / GIB));
  const shell = input.shell ? `; default shell ${input.shell}` : '';
  return `a ${computerKind(input.platform, input.arch)} running ${osName(input.platform)} (kernel ${input.release}, ${input.arch}), ${chip}, ${ram} GB RAM${shell}`;
}

let cached: string | null = null;

/** The line for this computer, e.g. "a Mac (Apple Silicon) running macOS (…), …". */
export function describeHostMachine(): string {
  if (cached === null) {
    cached = formatHostMachine({
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cpuModel: os.cpus()[0]?.model ?? null,
      cpuCount: os.cpus().length || 1,
      totalMemBytes: os.totalmem(),
      shell: shellName(process.platform),
    });
  }
  return cached;
}
