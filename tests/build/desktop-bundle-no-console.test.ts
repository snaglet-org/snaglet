import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { REMINDER_SOUNDS } from '../../packages/shared/types/reminders';

// A Snaglet Console app or binary is development-only tooling and must
// never be bundled into the packaged desktop app. Tauri ships only what
// bundle.externalBin (sidecar binaries), bundle.resources (copied files) and
// bundle.macOS.files (files copied into Contents/) declare, so this pins that
// surface across the base config and both release overlays. A companion assertion in apps/desktop/scripts/stage-sidecar.mjs
// enforces the same on every desktop build (the stage-desktop task).

const tauriDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../apps/desktop/src-tauri'
);

interface TauriConfig {
  bundle?: { externalBin?: unknown; resources?: unknown; macOS?: { files?: unknown } };
}

const readConfig = (name: string): TauriConfig =>
  JSON.parse(readFileSync(path.join(tauriDir, name), 'utf8')) as TauriConfig;

const base = readConfig('tauri.conf.json');
const production = readConfig('tauri.production.conf.json');
const preview = readConfig('tauri.preview.conf.json');

const CONSOLE_PATTERN = /console/i;

function bundleSurface(config: TauriConfig): string[] {
  const bundle = config.bundle ?? {};
  const externalBin = Array.isArray(bundle.externalBin) ? bundle.externalBin.map(String) : [];
  const resources = Array.isArray(bundle.resources)
    ? bundle.resources.map(String)
    : bundle.resources && typeof bundle.resources === 'object'
      ? Object.entries(bundle.resources as Record<string, unknown>)
          .flat()
          .map(String)
      : [];
  const macOSFiles = config.bundle?.macOS?.files;
  const contents =
    macOSFiles && typeof macOSFiles === 'object'
      ? Object.entries(macOSFiles as Record<string, unknown>)
          .flat()
          .map(String)
      : [];
  return [...externalBin, ...resources, ...contents];
}

for (const [name, config] of [
  ['base', base],
  ['production overlay', production],
  ['preview overlay', preview],
] as const) {
  test(`${name} tauri config bundles no Snaglet Console sidecar or resource`, () => {
    for (const declared of bundleSurface(config)) {
      assert.ok(
        !CONSOLE_PATTERN.test(declared),
        `Snaglet Console must not be bundled — found in ${name} tauri config: ${declared}`
      );
    }
  });
}

test('base config bundles exactly the Node sidecar and staged product resources', () => {
  assert.deepEqual(
    base.bundle?.externalBin,
    ['binaries/snaglet-node'],
    'base bundle.externalBin drifted — review the change and confirm no dev tooling ships'
  );
  assert.deepEqual(
    base.bundle?.resources,
    {
      'resources/server': 'server',
      'resources/cli': 'cli',
      'resources/pg': 'pg',
      'resources/rg': 'rg',
    },
    'base bundle.resources drifted — expected only the staged server, CLI, managed PostgreSQL runtime, and pinned ripgrep'
  );
});

test('macOS bundle files are exactly the reminder sounds, at the bundle root resources', () => {
  // UNNotificationSound soundNamed: looks in the main bundle's resources, so
  // native reminder notifications play the same WAVs the in-app banner does.
  const bundled = REMINDER_SOUNDS.filter((sound) => sound !== 'none');
  assert.deepEqual(
    base.bundle?.macOS?.files,
    Object.fromEntries(
      bundled.map((sound) => [
        `Resources/${sound}.wav`,
        `../../desktop-ui/public/sounds/reminders/${sound}.wav`,
      ])
    ),
    'base bundle.macOS.files drifted — expected only the reminder notification sounds'
  );
  for (const sound of bundled) {
    assert.ok(
      existsSync(path.join(tauriDir, `../../desktop-ui/public/sounds/reminders/${sound}.wav`)),
      `reminder sound ${sound}.wav is missing`
    );
  }
});

test('release overlays add no sidecars or resources that could smuggle dev tooling', () => {
  for (const [name, overlay] of [
    ['production', production],
    ['preview', preview],
  ] as const) {
    assert.equal(
      overlay.bundle?.externalBin,
      undefined,
      `${name} overlay must not declare externalBin`
    );
    assert.equal(
      overlay.bundle?.resources,
      undefined,
      `${name} overlay must not declare resources`
    );
    assert.equal(
      overlay.bundle?.macOS?.files,
      undefined,
      `${name} overlay must not declare macOS bundle files`
    );
  }
});
