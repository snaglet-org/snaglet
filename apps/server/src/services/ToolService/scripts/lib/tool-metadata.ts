import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type {
  BuiltinToolDefinition,
  ToolDefinition,
  ToolHandler,
} from '@server/services/ToolService/types';
import { logger } from '@server/config/logger';

// ESM at runtime; tests/support/import-meta-transform.cjs rewrites these two
// declarations to use Jest's CJS-injected globals when running under ts-jest.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TOOLS_DIR = path.resolve(__dirname, '..', '..', 'tools');

export interface ToolFolderEntry {
  /** Kebab-case folder (e.g. "database-query"). */
  folderName: string;
  /** Snake-case tool id (e.g. "database_query"). */
  toolId: string;
  /** Slash-delimited parent path used for navigation. */
  categoryPath: string;
  /** Tool directory path relative to tools/. */
  relativePath: string;
  /** Absolute path to the tool folder. */
  absPath: string;
}

export interface LoadedToolDefinition {
  folderName: string;
  toolId: string;
  categoryPath: string;
  definitionPath: string;
  toolPath: string;
  docsPath: string;
  toolSource: string;
  definition: ToolDefinition;
}

function toolIdToFolderName(toolId: string): string {
  return toolId.replace(/_/g, '-');
}

export function folderNameToToolId(folderName: string): string {
  return folderName.replace(/-/g, '_');
}

function hasToolFile(absDir: string): boolean {
  return existsSync(path.join(absDir, 'tool.ts')) || existsSync(path.join(absDir, 'tool.js'));
}

/**
 * Recursively find tool leaves. A leaf is any directory containing tool.ts/js;
 * its parent path becomes the category path.
 */
export function listToolFolders(): ToolFolderEntry[] {
  const entries: ToolFolderEntry[] = [];

  function walk(absDir: string): void {
    const children = readdirSync(absDir, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith('.') || child.name === 'node_modules') {
        continue;
      }
      const childAbs = path.join(absDir, child.name);
      if (hasToolFile(childAbs)) {
        const relativePath = path.relative(TOOLS_DIR, childAbs).split(path.sep).join('/');
        // The folder path IS the category, 1:1 with no transformation. Moving a
        // tool's folder changes its category automatically — the same derivation
        // runs in dev (dynamic discovery) and at bundle time (static codegen),
        // so dev/preview/production stay in sync via syncToDatabase() on boot.
        const rawCategory = path.posix.dirname(relativePath);
        entries.push({
          folderName: child.name,
          toolId: folderNameToToolId(child.name),
          categoryPath: rawCategory === '' || rawCategory === '.' ? 'uncategorized' : rawCategory,
          relativePath,
          absPath: childAbs,
        });
        continue;
      }
      walk(childAbs);
    }
  }

  walk(TOOLS_DIR);
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

/** Lookup a folder entry by folder name (kebab-case) or tool id (snake_case). */
export function findToolFolder(nameOrId: string): ToolFolderEntry | undefined {
  const normalized = nameOrId.includes('_') ? toolIdToFolderName(nameOrId) : nameOrId;
  const entries = listToolFolders();

  // Also accept an exact relative category/tool path.
  if (normalized.includes('/')) {
    return entries.find((e) => e.relativePath === normalized);
  }

  return entries.find((e) => e.folderName === normalized);
}

function resolveSourceOrCompiled(absDir: string, baseName: string): string | null {
  const ts = path.join(absDir, `${baseName}.ts`);
  if (existsSync(ts)) return ts;
  const js = path.join(absDir, `${baseName}.js`);
  if (existsSync(js)) return js;
  return null;
}

/** Resolve a tool folder's handler file (tool.ts in dev, tool.js in bundled builds). */
function resolveHandlerFile(entry: ToolFolderEntry): string | null {
  return resolveSourceOrCompiled(entry.absPath, 'tool');
}

/**
 * Dynamically import a tool's `tool.ts`/`tool.js` handler and validate its
 * default export is a function.
 *
 * This is the same import mechanism the runtime loader (registry-source.ts)
 * uses to build the live handler map; it is reused here (rather than
 * duplicated) so audit validation reflects real load behavior instead of
 * just reading tool.ts as text, which says nothing about whether the file
 * actually imports. Throws with a descriptive message on a missing file, an
 * import-time failure (syntax error, throwing top-level code, missing
 * import), or a default export that isn't a function.
 */
export async function loadToolHandler(entry: ToolFolderEntry): Promise<ToolHandler> {
  const handlerFile = resolveHandlerFile(entry);
  if (!handlerFile) {
    throw new Error(`Missing tool.ts/tool.js for ${entry.folderName}`);
  }

  const mod = (await import(pathToFileURL(handlerFile).href)) as { default?: unknown };
  const handler = mod?.default ?? mod;
  if (typeof handler !== 'function') {
    throw new Error(
      `${entry.folderName}/tool has no default export function (got ${typeof handler})`
    );
  }
  return handler as ToolHandler;
}

export async function loadToolDefinition(entry: ToolFolderEntry): Promise<LoadedToolDefinition> {
  const definitionPath = resolveSourceOrCompiled(entry.absPath, 'definition');
  const toolPath =
    resolveSourceOrCompiled(entry.absPath, 'tool') ?? path.join(entry.absPath, 'tool.ts');
  const docsPath = path.join(entry.absPath, 'TOOL.md');

  if (!definitionPath) {
    throw new Error(`Missing definition.ts for ${entry.folderName}`);
  }

  const module = (await import(pathToFileURL(definitionPath).href)) as {
    default?: BuiltinToolDefinition;
  };
  const rawDefinition = module.default;
  if (!rawDefinition) {
    throw new Error(`Definition file ${definitionPath} has no default export`);
  }

  // Filesystem path is the source of truth for builtin navigation.
  const definition: ToolDefinition = {
    ...rawDefinition,
    categoryPath: entry.categoryPath,
  };

  const toolSource = toolPath && existsSync(toolPath) ? readFileSync(toolPath, 'utf8') : '';

  return {
    folderName: entry.folderName,
    toolId: entry.toolId,
    categoryPath: entry.categoryPath,
    definitionPath,
    toolPath,
    docsPath,
    toolSource,
    definition,
  };
}

export async function loadAllToolDefinitions(): Promise<LoadedToolDefinition[]> {
  const entries = listToolFolders();
  const loaded = await Promise.all(entries.map((entry) => loadToolDefinition(entry)));
  return loaded.sort((a, b) => a.toolId.localeCompare(b.toolId));
}
