#!/usr/bin/env tsx

import { type ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { chmod, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnagletEnvironment } from '../packages/db/runtime/snaglet-env';

/**
 * Preview-mode packaged desktop app.
 *
 * Builds the desktop-preview artifact (Snaglet Preview.app / preview bundle) and
 * launches it with the preview environment resolved in this process first:
 * `SNAGLET_ENV=preview` → `.env.preview` plus mode defaults (`SNAGLET_HOME=~/.snaglet-dev`,
 * `SNAGLET_DATABASE_NAME=snaglet_preview`). Resolution must happen here because the Rust
 * shell reads concrete env vars (it honors `SNAGLET_HOME`, and forwards the rest to
 * the Node sidecar) — it does not read SNAGLET_ENV or env files itself.
 *
 * The artifact binary is executed directly (not via `open`) so the environment
 * reliably reaches the shell process and Ctrl-C tears the app down with it.
 * Launched by double-click instead, the preview app keeps its own profile
 * default home (`~/.snaglet-preview`) — this script is the supported preview-mode
 * entry point.
 *
 * Sharp edge (inherent to the hybrid layout): the preview app's sidecar owns
 * its PostgreSQL lifecycle, and preview shares dev's `~/.snaglet-dev` cluster —
 * quitting the preview app stops that cluster, so a concurrently running dev
 * server will need a restart to bring it back.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(repoRoot, 'apps', 'desktop', 'src-tauri', 'target', 'release');
const pnpm = 'pnpm';

process.env.SNAGLET_ENV = 'preview';
process.env.NODE_ENV ??= 'production';
loadSnagletEnvironment(repoRoot);

function run(command: string, args: string[], options: Record<string, unknown> = {}): ChildProcess {
  return crossSpawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`process exited with ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function newestMatchingFile(directory: string, pattern: RegExp): Promise<string | undefined> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const matches = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map(async (entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return { file, mtimeMs: (await stat(file)).mtimeMs };
      })
  );
  return matches.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file;
}

async function desktopArtifactBinary(): Promise<string> {
  if (process.platform === 'darwin') {
    return path.join(
      releaseDir,
      'bundle',
      'macos',
      'Snaglet Preview.app',
      'Contents',
      'MacOS',
      'desktop'
    );
  }
  if (process.platform === 'linux') {
    const appImage = await newestMatchingFile(path.join(releaseDir, 'bundle'), /\.AppImage$/);
    const artifact = appImage ?? path.join(releaseDir, 'desktop');
    await chmod(artifact, 0o755);
    return artifact;
  }
  if (process.platform === 'win32') {
    return path.join(releaseDir, 'desktop.exe');
  }
  throw new Error(`unsupported platform: ${process.platform}`);
}

console.log('Building packaged Snaglet desktop-preview application...');
const buildCode = await waitForExit(run(pnpm, ['run', 'build:desktop-preview']));
if (buildCode !== 0) process.exit(buildCode);

const binary = await desktopArtifactBinary();
await stat(binary);
console.log(`Launching ${binary}`);
console.log(
  `[preview:desktop] SNAGLET_HOME=${process.env.SNAGLET_HOME} SNAGLET_DATABASE_NAME=${process.env.SNAGLET_DATABASE_NAME}`
);

const app = run(binary, []);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => app.kill(signal));
}
process.exit(await waitForExit(app));
