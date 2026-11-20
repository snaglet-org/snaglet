/**
 * CustomToolScanner — folder-drop registration for user tools.
 *
 * A user drops a folder into
 * `<snaglet-home>/tools/<name>/` containing `definition.json` + `tool.ts`; on boot and
 * on change the server builds it (virtual SDK + esbuild, see buildToolBundle),
 * writes an enabled row into the `tools` table, and it becomes callable by an
 * agent — with no REST call, no UI, no manual pipeline trigger. Removing the
 * folder disables the row.
 *
 * The scanning/watching mechanics live in the generic `FolderScanner`, wired here
 * with tool-specific register/remove callbacks. The hooks scanner
 * (HookRegistryService) constructs another `FolderScanner` with its own callbacks.
 */

import { readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { logger } from '@server/config/logger';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { Tools } from '@snaglet/db/tables/tools';
import type { ToolRow, ToolTier } from '@snaglet/db/tables/tools';
import { SNAGLET_TOOLS_DIR } from '@server/services/snagletHome';
import {
  FolderScanner,
  type CommitFolderFingerprint,
  type ScannedFolder,
} from '@server/services/FolderScanner';
import { buildToolBundle, BUILT_TOOL_RELATIVE } from './buildToolBundle';
import { bundleUsesCurrentSdk } from './bundleVendoredEntry';
import { removeLegacySdkCopy } from './vendorSdk';

const LOG_PREFIX = '\x1b[35m[custom-tools]\x1b[0m';

/**
 * Canonical custom-tools directory. Mirrors ToolWorkspaceService's resolution so
 * the folder-drop scanner and the REST-create path always target one directory:
 * the `<snaglet-home>/tools` scaffold, with the same `TOOL_WORKSPACES_DIR` override.
 */
const CUSTOM_TOOLS_DIR = process.env.TOOL_WORKSPACES_DIR ?? SNAGLET_TOOLS_DIR;

/** Files a well-formed custom-tool folder must contain. */
export const CUSTOM_TOOL_REQUIRED_FILES = ['definition.json', 'tool.ts'] as const;

/** A folder's `source` key in the tools table. Stable regardless of rename. */
function sourceFor(folderName: string): string {
  return `workspace:${folderName}`;
}

/** DB id derived from the tool's declared name (same rule as the REST path). */
function toolIdFor(name: string): string {
  return name.replace(/-/g, '_');
}

/** Has any source file changed since the bundle was last built? */
async function bundleIsStale(builtPath: string, sources: string[]): Promise<boolean> {
  let builtMtime: number;
  try {
    builtMtime = (await stat(builtPath)).mtimeMs;
  } catch {
    return true; // no bundle yet
  }
  if (!(await bundleUsesCurrentSdk(builtPath))) return true;
  for (const src of sources) {
    try {
      if ((await stat(src)).mtimeMs > builtMtime) return true;
    } catch {
      return true; // a source vanished — force a rebuild attempt
    }
  }
  return false;
}

async function cleanLegacySdkCopies(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => removeLegacySdkCopy(path.join(dir, entry.name)))
    );
  } catch {
    // The scanner owns normal missing-directory handling.
  }
}

/**
 * Upsert the tools row from a parsed `definition.json`. Mirrors the REST path's
 * field mapping. `enabled` is applied with an explicit `setEnabled` because
 * `upsertTool` intentionally preserves `enabled` across upserts — for a
 * folder-backed tool the filesystem, not stored admin policy, is the source of
 * truth, so we assert the state after registering.
 */
async function upsertToolRow(
  folderName: string,
  definition: Record<string, unknown>,
  opts: { enabled: boolean; configJson: Record<string, unknown> }
): Promise<ToolRow> {
  const name = (definition.name as string) ?? folderName;
  const id = toolIdFor(name);
  const row = await Tools.upsertTool({
    id,
    name,
    description: (definition.description as string) ?? '',
    type: 'external',
    categoryPath: (definition.categoryPath as string) ?? 'custom',
    providerId: (definition.providerId as string) ?? null,
    tier: (definition.tier as ToolTier) ?? 'standard',
    parametersSchema: (definition.parametersSchema as Record<string, unknown>) ?? {},
    keywords: (definition.keywords as string[]) ?? [],
    source: sourceFor(folderName),
    sortOrder: 0,
    enabled: opts.enabled,
    configJson: opts.configJson,
  });
  const settled = await Tools.setEnabled(id, opts.enabled);
  return settled ?? row;
}

/** Disable a folder-backed tool by its source key (used on parse failure/removal). */
async function disableBySource(folderName: string): Promise<void> {
  const existing = await Tools.findBySource(sourceFor(folderName));
  if (existing && existing.enabled) {
    await Tools.setEnabled(existing.id, false);
    logger.info(`${LOG_PREFIX} disabled "${existing.name}" (folder gone or malformed)`);
  }
}

/**
 * Register a single tool folder: parse → (re)build if stale → deploy enabled.
 * Malformed input is logged with a clear prefix and leaves the server healthy;
 * the tool is disabled rather than left half-registered.
 */
export async function registerToolFolder(rootDir: string, folderName: string): Promise<void> {
  const folderPath = path.join(rootDir, folderName);
  const defPath = path.join(folderPath, 'definition.json');
  const toolPath = path.join(folderPath, 'tool.ts');

  let rawDef: string;
  try {
    rawDef = await readFile(defPath, 'utf-8');
  } catch (err) {
    logger.error(
      `${LOG_PREFIX} "${folderName}": cannot read definition.json — ${getErrorMessage(err)}`
    );
    await disableBySource(folderName);
    return;
  }

  const definition = safeJsonParse<Record<string, unknown> | null>(rawDef, null);
  if (!definition || typeof definition !== 'object' || typeof definition.name !== 'string') {
    logger.error(
      `${LOG_PREFIX} "${folderName}": definition.json is malformed (must be JSON with a string "name")`
    );
    await disableBySource(folderName);
    return;
  }

  const builtPath = path.join(folderPath, BUILT_TOOL_RELATIVE);
  if (await bundleIsStale(builtPath, [defPath, toolPath])) {
    logger.info(`${LOG_PREFIX} building "${folderName}"...`);
    const result = await buildToolBundle(folderPath);
    if (!result.success) {
      logger.error(
        `${LOG_PREFIX} BUILD FAILED for "${folderName}":\n${result.error ?? 'unknown error'}`
      );
      // Keep metadata visible but ensure a broken tool is never callable.
      await upsertToolRow(folderName, definition, { enabled: false, configJson: {} });
      return;
    }
    logger.info(`${LOG_PREFIX} built "${folderName}" in ${result.durationMs}ms`);
  }

  const tool = await upsertToolRow(folderName, definition, {
    enabled: true,
    configJson: {
      workspace_tool: true,
      workspace_dir: folderPath,
      built_path: builtPath,
    },
  });
  logger.info(`${LOG_PREFIX} registered "${tool.name}" (id=${tool.id}) → callable`);
}

let scanner: FolderScanner | undefined;

/** Build the tools FolderScanner bound to `dir` (defaults to `<snaglet-home>/tools`). */
function makeScanner(dir: string): FolderScanner {
  return new FolderScanner({
    dir,
    kind: 'custom-tools',
    requiredFiles: [...CUSTOM_TOOL_REQUIRED_FILES],
    onUpsert: (folder: ScannedFolder) => registerToolFolder(dir, folder.name),
    onRemove: (name: string) => disableBySource(name),
  });
}

function getOrCreateScanner(): FolderScanner {
  if (!scanner) scanner = makeScanner(CUSTOM_TOOLS_DIR);
  return scanner;
}

/** Start the boot scan + live watcher. Idempotent per process. */
export async function startCustomToolScanner(dir: string = CUSTOM_TOOLS_DIR): Promise<void> {
  await cleanLegacySdkCopies(dir);
  if (!scanner) scanner = makeScanner(dir);
  await scanner.start();
}

/**
 * Coordinate a REST-authored source mutation with the live folder scanner.
 * Lazily creating the scanner closes the interval between HTTP listen and the
 * background boot scan: a request in that window still seeds the same scanner
 * instance that `startCustomToolScanner()` will later begin watching.
 */
export async function withCustomToolUpsert<T>(
  folderName: string,
  mutation: (checkpointSource: () => Promise<CommitFolderFingerprint>) => Promise<T>
): Promise<T> {
  return getOrCreateScanner().withOwnedUpsert(folderName, mutation);
}

/** Coordinate a REST-owned delete while leaving deregistration scanner-owned. */
export async function withCustomToolRemove<T>(
  folderName: string,
  mutation: () => Promise<T>
): Promise<T> {
  return getOrCreateScanner().withOwnedRemove(folderName, mutation);
}

/** Stop watching (for shutdown / tests). */
export function stopCustomToolScanner(): void {
  scanner?.stop();
  scanner = undefined;
}
