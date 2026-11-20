#!/usr/bin/env tsx

/**
 * Universal tool runner — invokes any builtin tool the same way the agent runtime does.
 *
 * Usage:
 *   pnpm tool                                          # list all tools, grouped by category
 *   pnpm tool list [--category <path>]                 # same, optionally scoped
 *   pnpm tool categories                               # list distinct category paths
 *   pnpm tool help <id>                                # show a tool's parameters_schema
 *   pnpm tool <id> [--key value | key=value ...]       # run a tool
 *   pnpm tool <id> --params '<JSON>'                   # raw JSON params
 *   pnpm tool <id> --params-file <path>                # raw JSON params from file
 *   pnpm tool <id> --as-agent <id> --thread <id>       # supply agent/thread context
 *   pnpm tool <id> --project <id>                      # set project_id param (shorthand)
 *
 * ID resolution:
 *   • Exact match wins. Kebab-case is auto-converted to snake_case
 *     (`workspace-get-doc` → `workspace_get_doc`).
 *   • Bare names without an ID prefix resolve if unambiguous —
 *     `pnpm tool get-doc` finds `workspace_get_doc` only because no other
 *     tool ends in `_get_doc`. If two tools expose the same short
 *     name, use the full id.
 *
 * Flag parsing:
 *   • `--kebab-case` flags are converted to `snake_case` keys to match the
 *     tool parameter naming convention.
 *   • `"true"`, `"false"`, `"null"`, and pure numeric strings are coerced;
 *     anything else is passed as a string.
 *   • For nested objects / arrays, use `--params` or `--params-file`.
 */

import { readFileSync } from 'fs';
import { closeDatabase } from '../packages/db/index';
import { toolRegistry } from '../apps/server/src/services/ToolService/ToolRegistry';
import type { ToolHandlerContext } from '../apps/server/src/services/ToolService/types';

function toSnakeKey(key: string): string {
  return key.replace(/-/g, '_');
}

function coerceScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw !== '' && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function parseArgs(args: string[]): {
  params: Record<string, unknown>;
  context: ToolHandlerContext;
} {
  const params: Record<string, unknown> = {};
  const context: ToolHandlerContext = {};

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    if (token === '--params' || token === '--params-file') {
      const raw = args[++i];
      if (typeof raw !== 'string') {
        console.error(`${token} requires a JSON object argument`);
        process.exit(1);
      }
      const json = token === '--params-file' ? readFileSync(raw, 'utf8') : raw;
      try {
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not a JSON object');
        }
        Object.assign(params, parsed);
      } catch (err) {
        console.error(`Invalid ${token} JSON: ${(err as Error).message}`);
        process.exit(1);
      }
      continue;
    }

    if (token === '--as-agent') {
      context.agentId = args[++i];
      continue;
    }
    if (token === '--thread') {
      context.threadId = args[++i];
      continue;
    }
    // Shorthand for `--project-id <id>` — sets the `project_id` input
    // param. Auto-resolution via `--thread` only works when the thread
    // actually nests inside a project container; bulk/setup scripts that
    // don't have a thread to point at can just pin the project directly.
    if (token === '--project') {
      const next = args[++i];
      if (typeof next !== 'string') {
        console.error('--project requires an id argument');
        process.exit(1);
      }
      params.project_id = next;
      continue;
    }

    if (token.startsWith('--')) {
      const key = toSnakeKey(token.slice(2));
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        params[key] = true;
      } else {
        params[key] = coerceScalar(next);
        i++;
      }
      continue;
    }

    const eq = token.indexOf('=');
    if (eq > 0) {
      const key = toSnakeKey(token.slice(0, eq));
      params[key] = coerceScalar(token.slice(eq + 1));
      continue;
    }

    console.error(`Unrecognized argument: ${token}`);
    process.exit(1);
  }

  return { params, context };
}

function resolveToolId(requested: string): { id: string } | { error: string } {
  const ids = toolRegistry.getToolIds();
  const idSet = new Set(ids);
  const candidates = [requested, toSnakeKey(requested)];

  for (const c of candidates) {
    if (idSet.has(c)) return { id: c };
  }

  // Bare-name lookup: match tools whose id ends with `_<requested>` (or === requested).
  const needle = toSnakeKey(requested);
  const suffixMatches = ids.filter((id) => id === needle || id.endsWith(`_${needle}`));
  if (suffixMatches.length === 1) return { id: suffixMatches[0] };
  if (suffixMatches.length > 1) {
    return {
      error: `Ambiguous tool "${requested}". Matches: ${suffixMatches.join(', ')}. Use the full id.`,
    };
  }

  return { error: `Unknown tool: ${requested}` };
}

function listTools(filterCategory: string | null): void {
  const defs = Object.values(toolRegistry.getAllDefinitions()).sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  if (defs.length === 0) {
    console.log('No tools loaded. Run `pnpm sync:tool --all` first.');
    return;
  }

  const grouped = new Map<string, typeof defs>();
  for (const def of defs) {
    const category = def.categoryPath ?? 'custom';
    if (filterCategory && category !== filterCategory) continue;
    const list = grouped.get(category) ?? [];
    list.push(def);
    grouped.set(category, list);
  }

  if (grouped.size === 0) {
    console.log(`No tools in category "${filterCategory}".`);
    return;
  }

  const idWidth = Math.max(...defs.map((d) => d.id.length));
  for (const [category, list] of [...grouped.entries()].sort()) {
    console.log(`\n[${category}]  (${list.length})`);
    for (const def of list) {
      const firstLine = def.description.split('\n')[0];
      console.log(`  ${def.id.padEnd(idWidth)}  — ${firstLine}`);
    }
  }
  console.log('');
}

function listCategories(): void {
  const defs = Object.values(toolRegistry.getAllDefinitions());
  const counts = new Map<string, number>();
  for (const def of defs) {
    const category = def.categoryPath ?? 'custom';
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort();
  if (entries.length === 0) {
    console.log('No categories — run `pnpm sync:tool --all`.');
    return;
  }
  const nameWidth = Math.max(...entries.map(([tb]) => tb.length));
  console.log(`Categories (${entries.length}):\n`);
  for (const [category, n] of entries) {
    console.log(`  ${category.padEnd(nameWidth)}  ${n} tool${n === 1 ? '' : 's'}`);
  }
}

function showToolHelp(requested: string): void {
  const r = resolveToolId(requested);
  if ('error' in r) {
    console.error(r.error);
    process.exit(1);
  }
  const def = toolRegistry.getDefinition(r.id);
  if (!def) {
    console.error(`Definition missing for ${r.id}`);
    process.exit(1);
  }
  console.log(`${def.id}${def.categoryPath ? `  [${def.categoryPath}]` : ''}\n`);
  console.log(`${def.description}\n`);
  console.log('Parameters schema:');
  console.log(JSON.stringify(def.parameters_schema, null, 2));
}

async function main(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv;

  await toolRegistry.load();

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    listTools(null);
    return;
  }

  if (subcommand === 'list') {
    const categoryFlag = rest.indexOf('--category');
    const filter = categoryFlag >= 0 ? (rest[categoryFlag + 1] ?? null) : null;
    listTools(filter);
    return;
  }

  if (subcommand === 'categories') {
    listCategories();
    return;
  }

  if (subcommand === 'help') {
    if (!rest[0]) {
      console.error('Usage: pnpm tool help <id>');
      process.exit(1);
    }
    showToolHelp(rest[0]);
    return;
  }

  const resolved = resolveToolId(subcommand);
  if ('error' in resolved) {
    console.error(resolved.error);
    console.error('Run `pnpm tool list` to see available tools.');
    process.exit(1);
  }

  const handler = toolRegistry.getHandler(resolved.id);
  if (!handler) {
    console.error(`Handler not loaded for ${resolved.id}. Run \`pnpm sync:tool --all\`.`);
    process.exit(1);
  }

  const { params, context } = parseArgs(rest);

  const result = await handler(params, {}, context);
  if (typeof result === 'string') {
    console.log(result);
  } else if (result && typeof result === 'object' && 'output' in result) {
    console.log((result as { output: string }).output);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase().catch((err: unknown) => {
      console.error('tool: failed to close database cleanly', err);
    });
  });
