import crossSpawn from 'cross-spawn';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The desktop shell's Rust version is pinned in src-tauri/rust-toolchain.toml.
// The Tauri CLI asks `rustc -vV` for the host triple from its own working
// directory (apps/desktop), where rustup does not see that file; with no
// default toolchain rustup prints nothing there and the CLI panics. Every Tauri
// run therefore carries the pin in RUSTUP_TOOLCHAIN, which rustup applies to
// every rustc and cargo the CLI starts.

const tauriProject = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src-tauri');
const TOOLCHAIN_FILE = 'apps/desktop/src-tauri/rust-toolchain.toml';

/** The `channel` of the `[toolchain]` table in a rust-toolchain.toml. */
export function parseToolchainChannel(toml) {
  let inToolchain = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const table = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (table) {
      inToolchain = table[1] === 'toolchain';
      continue;
    }
    const channel = /^channel\s*=\s*"([^"]+)"$/.exec(line);
    if (inToolchain && channel) return channel[1];
  }
  throw new Error(`${TOOLCHAIN_FILE} has no [toolchain] channel`);
}

/** True when `reported` (e.g. `1.94.0`) is the version a numeric channel names. */
function matchesChannel(reported, channel) {
  return reported === channel || reported.startsWith(`${channel}.`);
}

/**
 * Why `tool` (rustc or cargo) cannot run the pinned toolchain, as a message
 * that names the fix, or null when it can. `result` is `<tool> --version` run
 * with RUSTUP_TOOLCHAIN set.
 *
 * @param {string} channel
 * @param {'rustc' | 'cargo'} tool
 * @param {{error?: {code?: string} | null, status: number | null, stdout?: string | null}} result
 */
export function rustToolchainProblem(channel, tool, result) {
  const install = `rustup toolchain install ${channel} --profile minimal`;
  if (result.error?.code === 'ENOENT') {
    return (
      `${tool} is not on your PATH. Install Rust from https://rustup.rs, open a new ` +
      `terminal (or run \`source ~/.cargo/env\`), then run \`${install}\`.`
    );
  }
  if (result.error || result.status !== 0) {
    return (
      `${tool} could not run Rust ${channel}, which ${TOOLCHAIN_FILE} pins (rustup's ` +
      `reason is above). Install it with \`${install}\`, then try again.`
    );
  }
  const reported = /\b(\d+\.\d+\.\d+)\b/.exec(result.stdout ?? '')?.[1];
  if (/^\d+\.\d+(\.\d+)?$/.test(channel) && !(reported && matchesChannel(reported, channel))) {
    return (
      `${tool} on your PATH is ${reported ?? 'an unknown version'}, not Rust ${channel} ` +
      `from ${TOOLCHAIN_FILE}, so it is not managed by rustup. Install Rust from ` +
      `https://rustup.rs and put ~/.cargo/bin first on your PATH.`
    );
  }
  return null;
}

function runVersion(tool, env) {
  // stderr stays on the terminal: rustup reports its own errors and any
  // toolchain download there.
  return crossSpawn.sync(tool, ['--version'], {
    cwd: tauriProject,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
}

/**
 * `env` with RUSTUP_TOOLCHAIN set to the pinned channel, after checking that
 * rustc and cargo run it. Exits the process with a plain message when they
 * cannot, before the Tauri CLI starts.
 */
export function pinRustToolchain(env = process.env) {
  const channel = parseToolchainChannel(
    readFileSync(path.join(tauriProject, 'rust-toolchain.toml'), 'utf8')
  );
  const pinned = { ...env, RUSTUP_TOOLCHAIN: channel };
  for (const tool of ['rustc', 'cargo']) {
    const problem = rustToolchainProblem(channel, tool, runVersion(tool, pinned));
    if (problem) {
      console.error(`[desktop] ${problem}`);
      process.exit(1);
    }
  }
  return pinned;
}
