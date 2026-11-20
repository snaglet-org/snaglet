/**
 * buildHookBundle — turn a hook folder's `hook.ts` into a self-contained,
 * runnable CJS bundle, reusing the custom tools' exact virtual-SDK + esbuild approach
 * (see customTools/bundleVendoredEntry). No `pnpm install`, no network.
 *
 * The generated entry is DUAL-MODE so the server can both discover a hook's
 * metadata and run it — always in a child process, never in-process:
 *
 *   node hook.cjs --describe   → prints `{ on, filter, schedule, repeatInChain }` as JSON
 *   node hook.cjs              → reads `{ event }` from stdin, calls run(event)
 *
 * Metadata (`on`/`filter`/…) is read via the describe spawn rather than by
 * `require()`-ing the built file in the server — importing user code in-process
 * (even just to read a field) runs its module top-level and breaks crash
 * isolation.
 *
 * Authors write `hook.ts` as:
 *   import { defineHook, snaglet } from '@snaglet/sdk';
 *   export default defineHook({ on: 'message:create', async run(event) { ... } });
 */

import path from 'path';
import { elapsedMs, getErrorMessage } from '@snaglet/shared/utils';
import {
  bundleVendoredEntry,
  formatBundleError,
} from '@server/services/ToolService/customTools/bundleVendoredEntry';

/** Built entry point, relative to a hook folder. */
export const BUILT_HOOK_RELATIVE = path.join('dist', 'hook.cjs');

export interface HookBuildResult {
  success: boolean;
  /** Absolute path to the built entry, when `success`. */
  builtPath?: string;
  output: string;
  error?: string;
  durationMs: number;
}

/**
 * Generated dual-mode entry. `./hook` resolves to the folder's `hook.ts` via
 * esbuild's `resolveDir`. Kept CJS-safe (no top-level await).
 */
const ENTRY_SOURCE = `
import def from './hook';

function resolveDef(d) {
  return d && d.default ? d.default : d;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

async function describe() {
  const d = resolveDef(def);
  const on = d ? d.on : undefined;
  const filter = d && d.filter ? d.filter : null;
  const schedule = d && Array.isArray(d.schedule) ? d.schedule : [];
  const repeatInChain = Boolean(d && d.repeatInChain === true);
  process.stdout.write(JSON.stringify({ on, filter, schedule, repeatInChain }));
}

async function run() {
  const raw = (await readStdin()).trim() || '{}';
  let payload = {};
  try { payload = JSON.parse(raw); } catch { payload = {}; }
  const event = payload && payload.event ? payload.event : payload;
  const d = resolveDef(def);
  if (!d || typeof d.run !== 'function') {
    throw new Error('hook.ts must "export default defineHook({ run })" with a run function');
  }
  await d.run(event);
}

const mode = process.argv.includes('--describe') ? 'describe' : 'run';
(mode === 'describe' ? describe() : run()).catch((err) => {
  process.stderr.write(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`;

/**
 * Build the hook at `hookDir` into `dist/hook.cjs`. Never throws — build
 * failures come back as `{ success: false, error }` so the caller can log and
 * leave the hook unregistered.
 */
export async function buildHookBundle(
  hookDir: string,
  outputPath: string = path.join(hookDir, BUILT_HOOK_RELATIVE)
): Promise<HookBuildResult> {
  const t0 = Date.now();
  const outfile = outputPath;
  try {
    const { warnings } = await bundleVendoredEntry({
      dir: hookDir,
      entrySource: ENTRY_SOURCE,
      outfile,
    });
    return {
      success: true,
      builtPath: outfile,
      output: warnings,
      durationMs: elapsedMs(t0),
    };
  } catch (err) {
    const structured = formatBundleError(err);
    return {
      success: false,
      output: structured,
      error: structured || getErrorMessage(err),
      durationMs: elapsedMs(t0),
    };
  }
}
