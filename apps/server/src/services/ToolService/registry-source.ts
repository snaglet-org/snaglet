/**
 * RegistrySource — the seam between ToolRegistry and how builtin tools are
 * located and loaded.
 *
 * This module is the DEV/DEFAULT implementation: filesystem discovery under
 * `tools/` + dynamic `import()` of each tool's `tool.ts` / `definition.ts`.
 *
 * The server bundle swaps this module at build time for the
 * generated static registry (`generated/registry-source.static.ts`, emitted
 * by `scripts/generate-tool-registry.ts`) — esbuild cannot statically follow
 * variable-path dynamic imports, so the bundle ships a codegen'd module with
 * one static import per tool instead. Both implementations export the same
 * surface; ToolRegistry is agnostic.
 */

import type { ToolHandler, ToolDefinition } from './types';
import { listToolFolders, loadToolDefinition, loadToolHandler } from './scripts/lib/tool-metadata';
import { logger } from '@server/config/logger';

export interface RegistryEntry {
  toolId: string;
  folderName: string;
  categoryPath: string;
  handler: ToolHandler;
  /** null when the definition failed to load — handler-only registration. */
  definition: ToolDefinition | null;
}

/**
 * Discover and load every builtin tool. Tools whose handler fails to load
 * are skipped (warned); tools whose definition fails still register the
 * handler (definition: null), matching the long-standing loader behavior.
 *
 * Handler loading goes through the shared `loadToolHandler` (tool-metadata.ts)
 * — the same dynamic-import mechanism the audit script's handler-import
 * check uses, so audit results reflect this runtime's real load behavior.
 */
export async function loadRegistryEntries(): Promise<RegistryEntry[]> {
  const entries = listToolFolders();
  const out: RegistryEntry[] = [];

  for (const entry of entries) {
    let handler: ToolHandler;
    try {
      handler = await loadToolHandler(entry);
    } catch (err) {
      logger.warn(`[registry-source] Failed to load ${entry.folderName}/tool:`, err);
      continue;
    }

    let definition: ToolDefinition | null = null;
    try {
      const loaded = await loadToolDefinition(entry);
      if (loaded.definition.id) {
        definition = loaded.definition;
      }
    } catch (err) {
      logger.warn(`[registry-source] Failed to load ${entry.folderName}/definition:`, err);
    }

    out.push({
      toolId: entry.toolId,
      folderName: entry.folderName,
      categoryPath: entry.categoryPath,
      handler,
      definition,
    });
  }

  return out.sort((a, b) => a.toolId.localeCompare(b.toolId));
}
