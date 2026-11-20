import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  builtArtifacts,
  bundleProcesses,
  cleanLeftovers,
  installerInstructions,
  installPaths,
  leftoverActions,
  otherRunningCopies,
  parseInstallAppArgs,
  parseProcessTable,
  planInstall,
  runInstallApp,
  runsInside,
  stageCopy,
  swapStaged,
  type InstallAppOptions,
} from '../../scripts/install-app';

const macOnly = process.platform === 'darwin' ? false : 'uses macOS ditto and plutil';
const quiet = (): void => {};

test('install:app defaults to building, installing into /Applications and opening Snaglet', () => {
  assert.deepEqual(parseInstallAppArgs([], '/work', '/tmp/test-home'), {
    skipBuild: false,
    launch: true,
    destDir: '/Applications',
    help: false,
  });
});

test('install:app resolves --dest against the folder it was run from and expands ~', () => {
  assert.deepEqual(
    parseInstallAppArgs(['--', '--skip-build', '--no-launch', '--dest', 'apps'], '/work', '/h'),
    { skipBuild: true, launch: false, destDir: resolve('/work', 'apps'), help: false }
  );
  assert.equal(
    parseInstallAppArgs(['--dest=~/Applications'], '/work', '/tmp/test-home').destDir,
    resolve('/tmp/test-home', 'Applications')
  );
});

test('install:app rejects unknown options and a --dest without a folder', () => {
  assert.throws(() => parseInstallAppArgs(['--force'], '/work', '/h'), /Unknown option/);
  assert.throws(() => parseInstallAppArgs(['--dest'], '/work', '/h'), /--dest needs a folder/);
  assert.throws(
    () => parseInstallAppArgs(['--dest', '--no-launch'], '/work', '/h'),
    /--dest needs a folder/
  );
});

test('the macOS plan builds, installs and launches, minus what the flags skip', () => {
  assert.deepEqual(planInstall('darwin', { skipBuild: false, launch: true }), [
    'check',
    'build',
    'install',
    'launch',
  ]);
  assert.deepEqual(planInstall('darwin', { skipBuild: true, launch: false }), ['check', 'install']);
});

test('other platforms build and then only show the installer', () => {
  assert.deepEqual(planInstall('win32', { skipBuild: false, launch: true }), [
    'check',
    'build',
    'show-installer',
  ]);
  assert.deepEqual(planInstall('linux', { skipBuild: true, launch: true }), [
    'check',
    'show-installer',
  ]);
});

test('the built app is the one build:desktop writes', () => {
  const dir = join('/repo', 'dist', 'desktop-production', 'artifacts');
  assert.deepEqual(builtArtifacts('/repo'), { dir, macApp: join(dir, 'Snaglet.app') });
});

test('working copies sit beside the app under names macOS does not treat as apps', () => {
  const paths = installPaths('/Applications');
  assert.equal(paths.app, join('/Applications', 'Snaglet.app'));
  for (const working of [paths.staging, paths.previous]) {
    assert.ok(working.startsWith(join('/Applications', '.Snaglet.app')));
    assert.ok(!working.endsWith('.app'));
  }
});

test('leftovers: a staged copy is removed and a moved-aside app goes back when it is the only copy', () => {
  assert.deepEqual(leftoverActions({ app: true, staging: false, previous: false }), []);
  assert.deepEqual(leftoverActions({ app: true, staging: true, previous: false }), [
    'remove-staging',
  ]);
  assert.deepEqual(leftoverActions({ app: false, staging: true, previous: true }), [
    'remove-staging',
    'restore-previous',
  ]);
  assert.deepEqual(leftoverActions({ app: true, staging: false, previous: true }), [
    'remove-previous',
  ]);
});

const PS_OUTPUT = [
  '    1     0 /sbin/launchd',
  '  500     1 /Applications/Snaglet.app/Contents/MacOS/desktop',
  '  501   500 /Applications/Snaglet.app/Contents/MacOS/snaglet-node /Applications/Snaglet.app/Contents/Resources/server/server.mjs',
  '  502   501 /Applications/Snaglet.app/Contents/Resources/pg/bin/postgres -D /tmp/test-home/postgres',
  '  600   501 /bin/zsh -l',
  '  601   600 node install-app.ts',
  '  700     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
  '  701   700 node install-app.ts',
  '  800     1 /tmp/test-builds/Snaglet.app/Contents/MacOS/desktop --flag',
  '  900     1 /Applications/Snaglet.app.old/Contents/MacOS/desktop',
  '',
].join('\n');

test('process table: finds every process started from the bundle', () => {
  const table = parseProcessTable(PS_OUTPUT);
  assert.equal(table.length, 10);
  assert.deepEqual(
    bundleProcesses(table, '/Applications/Snaglet.app').map((entry) => entry.pid),
    [500, 501, 502]
  );
});

test('process table: tells a shell inside Snaglet from a separate terminal', () => {
  const table = parseProcessTable(PS_OUTPUT);
  assert.equal(runsInside(table, 601, '/Applications/Snaglet.app'), true);
  assert.equal(runsInside(table, 701, '/Applications/Snaglet.app'), false);
  assert.equal(runsInside(table, 4242, '/Applications/Snaglet.app'), false);
});

test('process table: lists Snaglet copies running from other folders', () => {
  const table = parseProcessTable(PS_OUTPUT);
  assert.deepEqual(otherRunningCopies(table, '/Applications/Snaglet.app'), [
    '/tmp/test-builds/Snaglet.app',
  ]);
  assert.deepEqual(otherRunningCopies(table, '/tmp/test-builds/Snaglet.app'), [
    '/Applications/Snaglet.app',
  ]);
});

test('other platforms: points at the installer the build wrote', () => {
  const windows = installerInstructions('win32', 'C:\\snaglet\\artifacts', [
    'app',
    'SNAGLET_1.0.0_x64-setup.exe',
    'SHA256SUMS',
  ]);
  assert.ok(windows.some((line) => line.includes('SNAGLET_1.0.0_x64-setup.exe')));
  assert.ok(windows.some((line) => line.includes('docs/windows-development.md')));
  const linux = installerInstructions('linux', '/repo', ['app', 'snaglet_1.0.0_amd64.deb']);
  const debian = join('/repo', 'snaglet_1.0.0_amd64.deb');
  assert.ok(linux.some((line) => line.includes(`sudo apt install ${debian}`)));
  assert.ok(linux.some((line) => line.includes('does not work on Linux yet')));
  assert.throws(() => installerInstructions('win32', '/repo/artifacts', []), /No build found/);
});

interface Sandbox {
  root: string;
  source: string;
  dest: string;
  cleanup: () => void;
}

/** A fake bundle with the parts the installer reads: Info.plist and the main executable. */
function fakeApp(appPath: string, marker: string, identifier = 'com.snaglet.app'): void {
  mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(
    join(appPath, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>desktop</string>
</dict></plist>
`
  );
  writeFileSync(executable(appPath), `#!/bin/sh\n# ${marker}\n`);
  chmodSync(executable(appPath), 0o755);
}

function executable(appPath: string): string {
  return join(appPath, 'Contents', 'MacOS', 'desktop');
}

function marker(appPath: string): string {
  return readFileSync(executable(appPath), 'utf8');
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'snaglet-install-app-'));
  const source = join(root, 'build', 'Snaglet.app');
  const dest = join(root, 'Applications');
  fakeApp(source, 'new build');
  mkdirSync(dest);
  return { root, source, dest, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function options(dest: string): InstallAppOptions {
  return { skipBuild: true, launch: false, destDir: dest, help: false };
}

async function install(box: Sandbox, sourceApp = box.source): Promise<void> {
  await runInstallApp(options(box.dest), {
    repoRoot: box.root,
    platform: 'darwin',
    sourceApp,
    log: quiet,
  });
}

function workingCopiesLeft(dest: string): boolean {
  const paths = installPaths(dest);
  return existsSync(paths.staging) || existsSync(paths.previous);
}

test('installs into an empty folder and leaves no working copies', { skip: macOnly }, async () => {
  const box = sandbox();
  try {
    await install(box);
    assert.match(marker(join(box.dest, 'Snaglet.app')), /new build/);
    assert.equal(workingCopiesLeft(box.dest), false);
  } finally {
    box.cleanup();
  }
});

test('the installed copy carries no quarantine flag', { skip: macOnly }, async () => {
  const box = sandbox();
  try {
    const flag = 'com.apple.quarantine';
    execFileSync('xattr', ['-w', flag, '0081;00000000;Test;', executable(box.source)]);
    await install(box);
    const installed = executable(join(box.dest, 'Snaglet.app'));
    assert.equal(execFileSync('xattr', [installed], { encoding: 'utf8' }).includes(flag), false);
  } finally {
    box.cleanup();
  }
});

test('replaces an installed Snaglet with the new build', { skip: macOnly }, async () => {
  const box = sandbox();
  try {
    fakeApp(join(box.dest, 'Snaglet.app'), 'old build');
    await install(box);
    assert.match(marker(join(box.dest, 'Snaglet.app')), /new build/);
    assert.equal(workingCopiesLeft(box.dest), false);
  } finally {
    box.cleanup();
  }
});

test('leaves an app named Snaglet.app that is not Snaglet alone', { skip: macOnly }, async () => {
  const box = sandbox();
  try {
    fakeApp(join(box.dest, 'Snaglet.app'), 'someone else', 'com.example.other');
    await assert.rejects(install(box), /is not Snaglet/);
    assert.match(marker(join(box.dest, 'Snaglet.app')), /someone else/);
    assert.equal(workingCopiesLeft(box.dest), false);
  } finally {
    box.cleanup();
  }
});

test(
  '--skip-build without a built app fails before touching the destination',
  { skip: macOnly },
  async () => {
    const box = sandbox();
    try {
      fakeApp(join(box.dest, 'Snaglet.app'), 'old build');
      await assert.rejects(install(box, join(box.root, 'missing', 'Snaglet.app')), /No built app/);
      assert.match(marker(join(box.dest, 'Snaglet.app')), /old build/);
      assert.equal(workingCopiesLeft(box.dest), false);
    } finally {
      box.cleanup();
    }
  }
);

test('refuses a destination folder that does not exist', { skip: macOnly }, async () => {
  const box = sandbox();
  try {
    await assert.rejects(
      runInstallApp(options(join(box.root, 'nowhere')), {
        repoRoot: box.root,
        platform: 'darwin',
        sourceApp: box.source,
        log: quiet,
      }),
      /does not exist/
    );
  } finally {
    box.cleanup();
  }
});

test('a failed copy removes its partial copy', { skip: macOnly }, () => {
  const box = sandbox();
  try {
    const paths = installPaths(box.dest);
    assert.throws(
      () => stageCopy(join(box.root, 'missing', 'Snaglet.app'), paths.staging),
      /Copying/
    );
    assert.equal(existsSync(paths.staging), false);
  } finally {
    box.cleanup();
  }
});

test('a failed swap puts the installed app back', { skip: macOnly }, () => {
  const box = sandbox();
  try {
    const paths = installPaths(box.dest);
    fakeApp(paths.app, 'old build');
    assert.throws(() => swapStaged(paths, quiet), /previous app is back/);
    assert.match(marker(paths.app), /old build/);
    assert.equal(existsSync(paths.previous), false);
  } finally {
    box.cleanup();
  }
});

test('an app moved aside by an interrupted run is put back', { skip: macOnly }, () => {
  const box = sandbox();
  try {
    const paths = installPaths(box.dest);
    fakeApp(paths.previous, 'old build');
    fakeApp(paths.staging, 'partial copy');
    cleanLeftovers(paths, quiet);
    assert.match(marker(paths.app), /old build/);
    assert.equal(workingCopiesLeft(box.dest), false);
  } finally {
    box.cleanup();
  }
});
