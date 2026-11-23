/**
 * Set the version everywhere it is written, so the copies never drift:
 * every workspace package.json, the Tauri config, and the desktop crate
 * (Cargo.toml and its entry in Cargo.lock).
 *
 * usage: pnpm version:set 1.0.1
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Every file that carries the version, relative to the repository root. */
export function versionFiles(root = ROOT) {
  const packages = ['apps', 'packages'].flatMap((dir) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name, 'package.json'))
  );
  return ['package.json', ...packages, 'apps/desktop/src-tauri/tauri.conf.json'];
}

/** Replace the first `"version": "…"` in JSON text, keeping the file's formatting. */
export function setJsonVersion(text, version) {
  return text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
}

/** Replace the `[package]` version in Cargo.toml text. */
export function setCargoTomlVersion(text, version) {
  return text.replace(/(\[package\][^[]*?\nversion\s*=\s*")[^"]*(")/, `$1${version}$2`);
}

/** Replace the version of one crate's entry in Cargo.lock text. */
export function setCargoLockVersion(text, crate, version) {
  return text.replace(
    new RegExp(`(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")[^"]*(")`),
    `$1${version}$2`
  );
}

function rewrite(path, change) {
  let before;
  try {
    before = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  const after = change(before);
  if (after !== before) writeFileSync(path, after);
  return after !== before;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error('usage: pnpm version:set <x.y.z>');
    process.exit(2);
  }
  const changed = [];
  for (const file of versionFiles()) {
    const path = join(ROOT, file);
    let has = false;
    try {
      has = /"version"\s*:/.test(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    if (has && rewrite(path, (text) => setJsonVersion(text, version))) changed.push(file);
  }
  const crate = 'apps/desktop/src-tauri';
  if (rewrite(join(ROOT, crate, 'Cargo.toml'), (text) => setCargoTomlVersion(text, version)))
    changed.push(`${crate}/Cargo.toml`);
  if (
    rewrite(join(ROOT, crate, 'Cargo.lock'), (text) =>
      setCargoLockVersion(text, 'desktop', version)
    )
  )
    changed.push(`${crate}/Cargo.lock`);
  console.log(
    changed.length
      ? `Version ${version} written to:\n  ${changed.join('\n  ')}`
      : `Everything already says ${version}.`
  );
}
