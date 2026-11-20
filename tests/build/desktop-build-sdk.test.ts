import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test(
  'macOS desktop build selects the CLT SDK and respects an explicit SDKROOT',
  {
    skip: process.platform !== 'darwin',
  },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'snaglet-desktop-sdk-'));
    try {
      const bin = path.join(root, 'bin');
      const developer = path.join(root, 'Developer Tools');
      const sdk = path.join(developer, 'SDKs', 'MacOSX.sdk');
      mkdirSync(bin);
      mkdirSync(sdk, { recursive: true });
      for (const [name, body] of [
        ['xcode-select', 'printf "%s\\n" "$SNAGLET_TEST_DEVELOPER"'],
        ['tauri', 'printf "%s\\n" "$SDKROOT"'],
        // The Rust preflight runs first; these answer for the pinned toolchain.
        ['rustc', 'printf "rustc %s (fake)\\n" "$RUSTUP_TOOLCHAIN"'],
        ['cargo', 'printf "cargo %s (fake)\\n" "$RUSTUP_TOOLCHAIN"'],
      ]) {
        const file = path.join(bin, name);
        writeFileSync(file, `#!/bin/sh\n${body}\n`);
        chmodSync(file, 0o755);
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SNAGLET_TEST_DEVELOPER: developer,
      };
      delete env.SDKROOT;
      const script = path.resolve('apps/desktop/scripts/build-desktop.mjs');
      const run = (override?: string) =>
        execFileSync(process.execPath, [script, 'production'], {
          env: override ? { ...env, SDKROOT: override } : env,
          encoding: 'utf8',
        }).trim();
      assert.equal(run(), sdk);
      assert.equal(run('/explicit/sdk'), '/explicit/sdk');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
