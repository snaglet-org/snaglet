/**
 * ToolRegistry — auto-discovers tool folders and provides handler + definition lookups.
 *
 * Layout: tools/<category path>/<tool-name>/, with arbitrary category depth.
 *
 * Each tool folder has:
 *   - `tool.ts`       → default export is the ToolHandler
 *   - `definition.ts` → default export is the ToolDefinition
 *
 * Discovery is shared with the sync script via `scripts/lib/tool-metadata.ts`
 * so the runtime loader and the DB sync always agree on folder structure.
 */

import type { ToolHandler, ToolDefinition } from './types';
import { loadRegistryEntries } from './registry-source';
import { logger } from '@server/config/logger';

class ToolRegistryClass {
  private handlerMap: Map<string, ToolHandler> = new Map();
  private definitionMap: Map<string, ToolDefinition> = new Map();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  /**
   * Discover all tool folders and import their handlers + definitions.
   * Safe to call multiple times — only loads once. Concurrent calls share the same promise.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = this._doLoad();
    await this.loadPromise;
  }

  private async _doLoad(): Promise<void> {
    // The registry-source seam owns discovery + module loading. Dev: fs scan
    // + dynamic import. Bundled: a codegen'd static module (see
    // registry-source.ts header).
    const entries = await loadRegistryEntries();
    for (const entry of entries) {
      this.handlerMap.set(entry.toolId, entry.handler);
      if (entry.definition?.id) {
        this.definitionMap.set(entry.toolId, entry.definition);
      }
    }

    this.loaded = true;
    this.loadPromise = null;
  }

  /**
   * Force a fresh re-scan of the tool folders, rebuilding the handler and
   * definition maps. Unlike `load()`, this bypasses the `loaded` guard so
   * tools added to disk after boot become callable without a server restart.
   *
   * Used by the sync flow / dev endpoints so the loop is
   * build → sync → reload → verify (no process bounce).
   */
  async reload(): Promise<{ count: number }> {
    // Drain any in-flight load so we don't race a concurrent _doLoad.
    if (this.loadPromise) {
      await this.loadPromise;
    }
    this.handlerMap = new Map();
    this.definitionMap = new Map();
    this.loaded = false;
    this.loadPromise = null;
    await this.load();
    logger.info(`[ToolRegistry] reload complete — ${this.handlerMap.size} tools registered`);
    return { count: this.handlerMap.size };
  }

  /** Get a handler by tool id. Returns undefined if not found. */
  getHandler(toolId: string): ToolHandler | undefined {
    return this.handlerMap.get(toolId);
  }

  /** Get a definition by tool id. Returns undefined if not found. */
  getDefinition(toolId: string): ToolDefinition | undefined {
    return this.definitionMap.get(toolId);
  }

  /** Check if a handler exists for the given tool id. */
  hasHandler(toolId: string): boolean {
    return this.handlerMap.has(toolId);
  }

  /** Get all registered definitions as a plain object. */
  getAllDefinitions(): Record<string, ToolDefinition> {
    return Object.fromEntries(this.definitionMap);
  }

  /** Get all registered tool ids. */
  getToolIds(): string[] {
    return [...this.handlerMap.keys()];
  }

  /** Number of registered tools. */
  get size(): number {
    return this.handlerMap.size;
  }

  /** Whether the registry has been loaded. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Sync all loaded definitions to the database through the shared
   * reconciler (`lib/syncToolCatalog`), the same write path the explicit
   * CLI sync uses, so boot and CLI can never drift.
   *
   * Retire is soft (enabled=false, never DELETE) and every run verifies its
   * own writes by reading the catalog back; divergence is returned in
   * `errors` so callers that treat errors as fatal (e.g. the
   * DatabaseBackupService reset reseed) fail loudly. See the syncToolCatalog
   * module header.
   *
   * Retire is only allowed on a complete load: if even one definition.ts
   * failed to load, definitionMap is short, real tools would look like
   * orphans, and we'd disable them — so on any incomplete load the retire
   * pass is skipped for this cycle (upserts still run).
   */
  async syncToDatabase(): Promise<{ synced: number; errors: string[]; retired: number }> {
    const { syncToolCatalog, toolDefinitionToCreateInput } = await import('./lib/syncToolCatalog');

    let folderCount = -1;
    try {
      const { listToolFolders } = await import('./scripts/lib/tool-metadata');
      folderCount = listToolFolders().length;
    } catch {
      // Bundled build: no source folders on disk. The codegen'd static
      // registry can never load partially, so treat as complete.
    }
    const completeLoad =
      this.definitionMap.size > 0 && (folderCount < 0 || this.definitionMap.size >= folderCount);
    if (!completeLoad) {
      logger.warn(
        `[ToolRegistry] tool retire disabled this sync — incomplete load ` +
          `(loaded ${this.definitionMap.size}/${folderCount})`
      );
    }

    const defs = [...this.definitionMap.entries()].map(([toolId, def]) =>
      toolDefinitionToCreateInput(def, toolId)
    );

    const report = await syncToolCatalog(defs, {
      allowRetire: completeLoad,
      retireDisallowedReason: `incomplete load (${this.definitionMap.size}/${folderCount})`,
    });

    if (report.retired.length > 0) {
      logger.info(
        `[ToolRegistry] soft-retired ${report.retired.length} folderless tool(s): ` +
          report.retired.join(', ')
      );
    }
    if (report.divergence.length > 0) {
      logger.error(
        `[ToolRegistry] tool sync DIVERGED from the tree — DB does not match after write-back ` +
          `verification: ${report.divergence.join('; ')}`
      );
    }

    return {
      synced: report.added.length + report.updated.length,
      errors: [...report.errors, ...report.divergence],
      retired: report.retired.length,
    };
  }
}

export const toolRegistry = new ToolRegistryClass();
