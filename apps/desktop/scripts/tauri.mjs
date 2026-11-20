// Run the Tauri CLI (`node scripts/tauri.mjs dev`) with the Rust toolchain
// pinned in src-tauri/rust-toolchain.toml; see lib/rustToolchain.mjs.
import crossSpawn from 'cross-spawn';
import { pinRustToolchain } from './lib/rustToolchain.mjs';

const result = crossSpawn.sync('tauri', process.argv.slice(2), {
  stdio: 'inherit',
  env: pinRustToolchain(process.env),
  windowsHide: true,
});
if (result.error) throw new Error('Could not start the Tauri CLI', { cause: result.error });
process.exitCode = result.status ?? 1;
