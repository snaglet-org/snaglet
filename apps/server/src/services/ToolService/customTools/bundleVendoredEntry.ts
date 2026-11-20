/**
 * bundleVendoredEntry — the shared "virtual @snaglet/sdk + esbuild" core
 * into a self-contained CJS file" core, extracted so custom TOOLS and
 * custom HOOKS build the exact same way with no drift.
 *
 * It sidesteps the install seam identically for both:
 *   1. Resolve `@snaglet/sdk` from Snaglet-owned in-memory source instead of installing it.
 *   2. Bundle with the server's own esbuild JS API — no `pnpm install`, no
 *      network, no reliance on an on-PATH esbuild binary.
 *   3. `alias` pins the bare `@snaglet/sdk` specifier to the vendored file so
 *      resolution is deterministic regardless of node_modules layout.
 *   4. Emit CommonJS so `node <out>` runs it regardless of the folder's
 *      `package.json` `type`.
 *
 * The caller supplies the generated ENTRY source (which imports the author's
 * module via a relative path resolved against `dir`) and the output path.
 * Throws on esbuild failure — callers translate the BuildFailure into their own
 * structured result.
 */

import { build as esbuild, type Plugin } from 'esbuild';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { safeJsonParse } from '@snaglet/shared/utils';
import {
  removeLegacySdkCopy,
  SDK_RUNTIME_HASH,
  SDK_RUNTIME_SOURCE,
  SDK_SPECIFIER,
} from './vendorSdk';

const SDK_NAMESPACE = 'snaglet-sdk-runtime';
const BUNDLE_METADATA_SUFFIX = '.snaglet-build.json';

interface BundleMetadata {
  sdkHash: string;
}

function sdkPlugin(): Plugin {
  return {
    name: SDK_NAMESPACE,
    setup(build) {
      build.onResolve({ filter: /^@snaglet\/sdk$/ }, () => ({
        path: SDK_SPECIFIER,
        namespace: SDK_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: SDK_NAMESPACE }, () => ({
        contents: SDK_RUNTIME_SOURCE,
        loader: 'js',
      }));
    },
  };
}

function bundleMetadataPath(outfile: string): string {
  return `${outfile}${BUNDLE_METADATA_SUFFIX}`;
}

export async function bundleUsesCurrentSdk(outfile: string): Promise<boolean> {
  try {
    const raw = await readFile(bundleMetadataPath(outfile), 'utf-8');
    return safeJsonParse<BundleMetadata | null>(raw, null)?.sdkHash === SDK_RUNTIME_HASH;
  } catch {
    return false;
  }
}

async function writeBundleMetadata(outfile: string): Promise<void> {
  const metadataPath = bundleMetadataPath(outfile);
  const temporaryPath = `${metadataPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ sdkHash: SDK_RUNTIME_HASH })}\n`, 'utf-8');
  await rename(temporaryPath, metadataPath);
}

export interface BundleVendoredEntryOptions {
  /** The author's folder — `resolveDir` for the entry + where the SDK is vendored. */
  dir: string;
  /** Generated TS entry source (imports `./tool` or `./hook` + wires stdin/stdout). */
  entrySource: string;
  /** Absolute output path for the bundled `.cjs`. */
  outfile: string;
}

export interface BundleVendoredEntryResult {
  /** esbuild warnings joined by newline (empty when none). */
  warnings: string;
}

export async function bundleVendoredEntry(
  opts: BundleVendoredEntryOptions
): Promise<BundleVendoredEntryResult> {
  await mkdir(path.dirname(opts.outfile), { recursive: true });

  const result = await esbuild({
    stdin: {
      contents: opts.entrySource,
      resolveDir: opts.dir,
      sourcefile: '__snaglet_entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: opts.outfile,
    plugins: [sdkPlugin()],
    logLevel: 'silent',
  });

  await writeBundleMetadata(opts.outfile);
  await removeLegacySdkCopy(opts.dir);

  return { warnings: result.warnings.map((w) => w.text).join('\n') };
}

/**
 * Translate an esbuild BuildFailure (or any thrown error) into a compact,
 * multi-line message. Shared by tool + hook builders so their error surfaces
 * read identically.
 */
export function formatBundleError(err: unknown): string {
  if (err && typeof err === 'object' && 'errors' in err) {
    const structured = (
      err as {
        errors: { text: string; location?: { file?: string; line?: number } | null }[];
      }
    ).errors
      .map((e) =>
        e.location ? `${e.location.file ?? ''}:${e.location.line ?? ''} ${e.text}` : e.text
      )
      .join('\n');
    if (structured) return structured;
  }
  return '';
}
