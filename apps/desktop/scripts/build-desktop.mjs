import crossSpawn from 'cross-spawn';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinRustToolchain } from './lib/rustToolchain.mjs';

const profile = process.argv[2];
const bundleOnly = process.argv[3] === '--bundle-only';
if (
  (profile !== 'preview' && profile !== 'production') ||
  (process.argv[3] !== undefined && !bundleOnly) ||
  process.argv.length > 4
) {
  throw new Error('Usage: node scripts/build-desktop.mjs <preview|production> [--bundle-only]');
}

const bundles = { darwin: 'app', win32: 'nsis', linux: 'deb' }[process.platform];
if (!bundles) throw new Error(`Desktop packaging is unsupported on ${process.platform}`);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const buildEnvironment = pinRustToolchain(process.env);
if (process.platform === 'darwin' && !buildEnvironment.SDKROOT) {
  // Rust's linker needs the same SDK selection as the Swift helpers and PG.
  // xcrun may otherwise pick a leftover newer SDK incompatible with the CLT.
  buildEnvironment.SDKROOT = execFileSync(
    'bash',
    [
      '-c',
      'source "$1"; snaglet_macos_sdk',
      '--',
      path.join(repository, 'apps/server/native/macos-sdk.sh'),
    ],
    { encoding: 'utf8', env: buildEnvironment }
  ).trim();
}
const windowsConfig = path.resolve(
  repository,
  process.env.SNAGLET_BUILD_OUTPUT ?? `dist/desktop-${profile}`,
  'windows-bundle-config.json'
);
const result = crossSpawn.sync(
  'tauri',
  [
    bundleOnly ? 'bundle' : 'build',
    '--config',
    `src-tauri/tauri.${profile}.conf.json`,
    ...(process.platform === 'win32' ? ['--config', windowsConfig] : []),
    '--bundles',
    bundles,
    '--no-sign',
    '--ci',
    ...(bundleOnly ? [] : ['--', '--locked']),
  ],
  { stdio: 'inherit', env: buildEnvironment, windowsHide: true }
);
if (result.error) throw new Error('Could not start the Tauri build', { cause: result.error });
process.exitCode = result.status ?? 1;
