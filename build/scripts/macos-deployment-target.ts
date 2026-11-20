import { spawnSync } from 'node:child_process';

function compareDottedVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function parseMachOMinimumMacOSVersion(loadCommands: string): string | null {
  let command: 'build-version' | 'legacy-version' | null = null;
  for (const line of loadCommands.split('\n')) {
    const value = line.trim();
    if (value.startsWith('cmd ')) {
      command =
        value === 'cmd LC_BUILD_VERSION'
          ? 'build-version'
          : value === 'cmd LC_VERSION_MIN_MACOSX'
            ? 'legacy-version'
            : null;
      continue;
    }
    const match =
      command === 'build-version'
        ? value.match(/^minos\s+([0-9]+(?:\.[0-9]+)*)$/)
        : command === 'legacy-version'
          ? value.match(/^version\s+([0-9]+(?:\.[0-9]+)*)$/)
          : null;
    if (match?.[1]) return match[1];
  }
  return null;
}

export function assertMachOSupportsMacOSVersion(
  file: string,
  supportedVersion: string
): string | null {
  if (process.platform !== 'darwin') return null;
  const description = spawnSync('/usr/bin/file', ['-b', file], { encoding: 'utf8' });
  if (description.status !== 0 || !description.stdout.includes('Mach-O')) return null;

  const result = spawnSync('/usr/bin/otool', ['-l', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `Unable to inspect the macOS deployment target for ${file}: ${(result.stderr || result.stdout).trim()}`
    );
  }
  const minimumVersion = parseMachOMinimumMacOSVersion(result.stdout);
  if (!minimumVersion) {
    throw new Error(`Mach-O has no macOS deployment target load command: ${file}`);
  }
  if (compareDottedVersions(minimumVersion, supportedVersion) > 0) {
    throw new Error(
      `Mach-O requires macOS ${minimumVersion}, newer than Snaglet's supported macOS ${supportedVersion}: ${file}`
    );
  }
  return minimumVersion;
}
