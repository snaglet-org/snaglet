/**
 * buildToolBundle — turn a tool folder's `tool.ts` into a self-contained,
 * runnable bundle, with no dependency on the monorepo or a package registry.
 *
 * How it sidesteps the historical install seam:
 *   1. Supply `@snaglet/sdk` as a Snaglet-owned virtual build module instead of installing it.
 *   2. Bundle with the server's own esbuild via its JS API — no `pnpm install`,
 *      no reliance on an `esbuild` binary being on the folder's PATH.
 *   3. Wrap the author's `export default handler(input, context)` in a generated
 *      stdin/stdout entry, so the output matches what ToolExecutor spawns
 *      (`node <built>` with the call payload on stdin).
 *   4. Emit CommonJS to a `.cjs` file so `node` runs it regardless of whether the
 *      folder has a `package.json` or what its `type` field says.
 *
 * The result is a single file with the SDK inlined — nothing to resolve at run
 * time. Authors write `tool.ts` as:
 *
 *   import snaglet from '@snaglet/sdk';
 *   export default async function handler(input, context) { return 'result'; }
 */

import path from 'path';
import { elapsedMs, getErrorMessage } from '@snaglet/shared/utils';
import { bundleVendoredEntry, formatBundleError } from './bundleVendoredEntry';

/** Built entry point, relative to a tool folder. */
export const BUILT_TOOL_RELATIVE = path.join('dist', 'tool.cjs');

export interface ToolBuildResult {
  success: boolean;
  /** Absolute path to the built entry, when `success`. */
  builtPath?: string;
  output: string;
  error?: string;
  durationMs: number;
}

/**
 * Generated entry: read the ToolExecutor's `{ tool, input, context }` payload
 * from stdin, invoke the author's default export, and write the result to
 * stdout. Kept CJS-safe (no top-level await). `./tool` resolves to the folder's
 * `tool.ts` via esbuild's `resolveDir`.
 */
const ENTRY_SOURCE = `
import handler from './tool';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  const raw = (await readStdin()).trim() || '{}';
  let payload = {};
  try { payload = JSON.parse(raw); } catch { payload = {}; }
  const input = payload && payload.input ? payload.input : {};
  const context = payload && payload.context ? payload.context : {};
  const fn = handler && handler.default ? handler.default : handler;
  if (typeof fn !== 'function') {
    throw new Error('tool.ts must "export default" a handler function');
  }
  const result = await fn(input, context);
  process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result));
}

main().catch((err) => {
  process.stderr.write(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`;

/**
 * Build the tool at `toolDir` into `dist/tool.cjs`. Never throws — build
 * failures come back as `{ success: false, error }` so the caller can log and
 * leave the tool disabled.
 */
export async function buildToolBundle(toolDir: string): Promise<ToolBuildResult> {
  const t0 = Date.now();
  const outfile = path.join(toolDir, BUILT_TOOL_RELATIVE);
  try {
    // Resolve Snaglet's virtual @snaglet/sdk + emit a self-contained CJS file
    // via the shared bundler (same core the hook builder uses).
    const { warnings } = await bundleVendoredEntry({
      dir: toolDir,
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
    // esbuild throws a BuildFailure with a structured `errors` array; fall back
    // to the generic message for anything else (e.g. fs failures).
    const structured = formatBundleError(err);
    return {
      success: false,
      output: structured,
      error: structured || getErrorMessage(err),
      durationMs: elapsedMs(t0),
    };
  }
}
