import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseToolchainChannel,
  rustToolchainProblem,
} from '../../apps/desktop/scripts/lib/rustToolchain.mjs';

const pinnedToml = readFileSync(path.resolve('apps/desktop/src-tauri/rust-toolchain.toml'), 'utf8');
const ok = (stdout: string) => ({ status: 0, stdout });

test('the pinned channel is read from the [toolchain] table', () => {
  assert.equal(parseToolchainChannel(pinnedToml), '1.94.0');
  assert.equal(
    parseToolchainChannel(
      '# pinned for the shell\n[other]\nchannel = "nightly"\n\n[ toolchain ]\nprofile = "minimal"\nchannel = "1.95.1" # comment\n'
    ),
    '1.95.1'
  );
  assert.throws(
    () => parseToolchainChannel('[toolchain]\nprofile = "minimal"\n'),
    /no \[toolchain\] channel/
  );
});

test('a missing rustc or cargo names the rustup install and the pinned toolchain', () => {
  const missing = { error: { code: 'ENOENT' }, status: null, stdout: null };
  for (const tool of ['rustc', 'cargo'] as const) {
    const message = rustToolchainProblem('1.94.0', tool, missing) ?? '';
    assert.match(message, new RegExp(`^${tool} is not on your PATH`));
    assert.match(message, /https:\/\/rustup\.rs/);
    assert.match(message, /rustup toolchain install 1\.94\.0 --profile minimal/);
  }
});

test('a pinned toolchain rustup cannot run is reported with the install command', () => {
  const message = rustToolchainProblem('1.94.0', 'rustc', { status: 1, stdout: '' }) ?? '';
  assert.match(message, /rustc could not run Rust 1\.94\.0/);
  assert.match(message, /apps\/desktop\/src-tauri\/rust-toolchain\.toml/);
  assert.match(message, /rustup toolchain install 1\.94\.0 --profile minimal/);
});

test('a Rust that is not rustup-managed and reports another version is refused', () => {
  assert.match(
    rustToolchainProblem('1.94.0', 'rustc', ok('rustc 1.95.0 (Homebrew)\n')) ?? '',
    /rustc on your PATH is 1\.95\.0, not Rust 1\.94\.0/
  );
  assert.match(
    rustToolchainProblem('1.94.0', 'cargo', ok('cargo: unexpected output\n')) ?? '',
    /is an unknown version/
  );
});

test('the pinned version passes, including a channel that names only major.minor', () => {
  assert.equal(
    rustToolchainProblem('1.94.0', 'rustc', ok('rustc 1.94.0 (4a4ef493e 2026-03-02)\n')),
    null
  );
  assert.equal(
    rustToolchainProblem('1.94.0', 'cargo', ok('cargo 1.94.0 (abc 2026-02-27)\n')),
    null
  );
  assert.equal(rustToolchainProblem('1.94', 'rustc', ok('rustc 1.94.2 (abc 2026-04-01)\n')), null);
  assert.equal(rustToolchainProblem('stable', 'rustc', ok('rustc 1.99.0 (abc)\n')), null);
});

/** A bin folder of fake tools; `rustcBody` is the fake rustc's shell body. */
function fakeTools(root: string, rustcBody: string): string {
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const tools: Array<[string, string]> = [
    ['rustc', rustcBody],
    ['cargo', 'printf "cargo %s (fake)\\n" "$RUSTUP_TOOLCHAIN"'],
    ['tauri', 'printf "tauri %s toolchain=%s\\n" "$*" "$RUSTUP_TOOLCHAIN"'],
  ];
  for (const [name, body] of tools) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return bin;
}

function run(script: string, args: string[], bin: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    SDKROOT: '/explicit/sdk',
  };
  delete env.RUSTUP_TOOLCHAIN;
  return spawnSync(process.execPath, [path.resolve(script), ...args], {
    env,
    encoding: 'utf8',
  });
}

test(
  'desktop packaging and the Tauri runner hand the pinned toolchain to the Tauri CLI',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'snaglet-rust-toolchain-'));
    try {
      const bin = fakeTools(root, 'printf "rustc %s (fake)\\n" "$RUSTUP_TOOLCHAIN"');
      const build = run('apps/desktop/scripts/build-desktop.mjs', ['production'], bin);
      assert.equal(build.status, 0, build.stderr);
      assert.match(build.stdout, /^tauri build .* toolchain=1\.94\.0$/m);
      const dev = run('apps/desktop/scripts/tauri.mjs', ['dev', '--verbose'], bin);
      assert.equal(dev.status, 0, dev.stderr);
      assert.equal(dev.stdout.trim(), 'tauri dev --verbose toolchain=1.94.0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'a pinned toolchain that will not run stops the build before the Tauri CLI starts',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'snaglet-rust-toolchain-'));
    try {
      const bin = fakeTools(
        root,
        'echo "error: toolchain \'$RUSTUP_TOOLCHAIN\' is not installed" >&2; exit 1'
      );
      for (const [script, args] of [
        ['apps/desktop/scripts/build-desktop.mjs', ['production']],
        ['apps/desktop/scripts/tauri.mjs', ['dev']],
      ] as const) {
        const result = run(script, [...args], bin);
        assert.equal(result.status, 1, script);
        assert.match(result.stderr, /error: toolchain '1\.94\.0' is not installed/);
        assert.match(
          result.stderr,
          /\[desktop\] rustc could not run Rust 1\.94\.0[\s\S]*rustup toolchain install 1\.94\.0 --profile minimal/
        );
        assert.doesNotMatch(result.stdout, /^tauri /m, `${script} must not start the Tauri CLI`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
