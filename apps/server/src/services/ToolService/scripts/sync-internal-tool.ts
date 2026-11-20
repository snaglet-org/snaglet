/**
 * sync-internal-tool — Sync folder-derived tool definitions to the DB.
 *
 * Usage:
 *   pnpm sync:tool <tool-name|--all>
 *
 * Tool lookup accepts either:
 *   - folder name:        pnpm sync:tool date-time
 *   - tool id:            pnpm sync:tool date_time
 *   - <category>/<name>:  pnpm sync:tool data/database/database-query
 *
 * --all syncs every discovered tool.
 *
 * Writes need an explicit target, like every db script:
 *   SNAGLET_ENV=dev pnpm sync:tool --all      or      pnpm sync:tool --all --target=dev
 */

import { closeDatabase, Tools } from '@snaglet/db';
import { guardScriptTarget, parseScriptArgs } from '@snaglet/db/runtime/script-target';
import {
  syncToolCatalog,
  toolDefinitionToCreateInput,
} from '@server/services/ToolService/lib/syncToolCatalog';
import {
  findToolFolder,
  loadToolDefinition,
  loadAllToolDefinitions,
  listToolFolders,
  TOOLS_DIR,
  type ToolFolderEntry,
} from './lib/tool-metadata';

async function syncOne(name: string) {
  const entry = findToolFolder(name);
  if (!entry) {
    console.error(`Tool folder not found for: ${name}`);
    console.error(`\nSearched under ${TOOLS_DIR}. Available tools:`);
    for (const e of listToolFolders()) {
      console.error(`  ${e.relativePath}`);
    }
    process.exit(1);
  }

  const loaded = await loadToolDefinition(entry);
  const row = await Tools.upsertTool(toolDefinitionToCreateInput(loaded.definition));

  // Verify the write landed — read it back through a fresh query rather than
  // trusting the upsert's RETURNING row.
  const check = await Tools.findById(row.id);
  if (!check) {
    throw new Error(`sync verification failed: ${row.id} was upserted but reads back missing`);
  }
  console.log(`synced ${check.id} (${check.name})  [${entry.categoryPath}]`);
}

/**
 * Sync every discovered tool folder to the DB, via the shared reconciler
 * (`lib/syncToolCatalog`), the same write path the server's boot-time sync
 * uses, so the two can never drift semantically. This is the path
 * `pnpm db:migrate` chains after the SQL migrate, so it must be safe to run
 * against a tree that might be partially checked out:
 *
 *   - Retire is soft (enabled=false), never a hard delete. Deleting a tool row
 *     would also drop its agent assignments; a missing folder must not be
 *     destructive. Re-adding the folder preserves the row's current enabled
 *     state; enable it explicitly from the Tools view when needed.
 *   - Count guard: if the tree exposes fewer than half the tools the DB has
 *     enabled, the retire pass is skipped entirely (a near-empty tree must not
 *     wipe the registry) — but discovered tools are still upserted.
 *   - The sync verifies its own writes: it reads the catalog back and fails
 *     (non-zero exit) if the DB does not match the intended set — e.g. when a
 *     concurrent writer (another checkout's server booting against the same
 *     shared DB) reverses the writes mid-run.
 *
 * Returns false when the sync diverged, so main() can exit non-zero.
 */
async function syncAll(): Promise<boolean> {
  const tools = await loadAllToolDefinitions();
  const defs = tools.map((t) => toolDefinitionToCreateInput(t.definition, t.toolId));

  const report = await syncToolCatalog(defs);

  for (const id of report.added) console.log(`  added ${id}`);
  for (const id of report.retired) console.log(`  retired ${id} (folder removed → enabled=false)`);
  if (report.retireSkipped) {
    console.warn(`⚠ retire pass SKIPPED — ${report.retireSkipReason}`);
  }
  console.log(
    `discovered=${report.discovered} added=${report.added.length} ` +
      `updated=${report.updated.length} retired=${report.retired.length} ` +
      `retire_skipped=${report.retireSkipped} verified=${report.ok}`
  );

  if (!report.ok) {
    for (const err of report.errors) console.error(`✗ error: ${err}`);
    for (const div of report.divergence) console.error(`✗ divergence: ${div}`);
    console.error(
      '✗ sync verification FAILED — the database does not match the tool tree. ' +
        'If another Snaglet server from a different checkout shares this database, its boot ' +
        'sync may be fighting this one; sync from the checkout that should win, and keep ' +
        'stale checkouts from booting against this database.'
    );
  }
  return report.ok;
}

function formatEntry(e: ToolFolderEntry): string {
  return e.relativePath;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  // --target / --dry-run belong to the db-script guard; the rest are ours.
  const args = parseScriptArgs(rawArgs).rest;

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: sync-internal-tool <tool-name|--all>`);
    console.log(`\n  <tool-name>  Folder name, tool id, or <category path>/<name>`);
    console.log(`  --all        Sync all tool folders to the database`);
    console.log(`  --list       List available tool folders`);
    process.exit(0);
  }

  if (args.includes('--list')) {
    const entries = listToolFolders();
    console.log(`${entries.length} tool folders in ${TOOLS_DIR}:\n`);
    for (const e of entries) {
      console.log(`  ${formatEntry(e)}`);
    }
    process.exit(0);
  }

  // Target guard: this writes the tools table, so it needs the same
  // explicit target as db:migrate (which passes --target through to it).
  const target = guardScriptTarget('sync-tool', rawArgs);
  if (!target) return; // refused: exit code 2, nothing opened
  if (target.dryRun) {
    console.error('[db] dry run: target resolved; no tools were synced.');
    return;
  }

  if (args.includes('--all')) {
    const ok = await syncAll();
    if (!ok) {
      // Divergence: report through the exit code and skip the server reload —
      // a registry refresh against a catalog we know is wrong helps nobody.
      process.exitCode = 1;
      return;
    }
  } else {
    for (const name of args) {
      await syncOne(name);
    }
  }

  // Best-effort: tell a running server to re-scan its handler map so the
  // newly-synced tool becomes callable WITHOUT a restart. If no server is
  // listening (CLI-only use), this is a no-op — it never fails the sync.
  await triggerServerReload();
}

async function triggerServerReload(): Promise<void> {
  const baseUrl = process.env.API_BASE_URL;
  if (!baseUrl) {
    console.log(
      'ℹ API_BASE_URL is not set — DB synced; restart the server to register new handlers'
    );
    return;
  }
  const url = `${baseUrl}/api/tools/reload`;
  try {
    const res = await fetch(url, { method: 'POST' });
    if (res.ok) {
      const body = (await res.json()) as { data?: { count?: number } };
      const count = body?.data?.count;
      console.log(
        `\u2713 reloaded running server registry${count != null ? ` (${count} tools registered)` : ''}`
      );
    } else {
      console.log(`\u26a0 server reload returned HTTP ${res.status} — restart may be needed`);
    }
  } catch {
    console.log(
      `\u2139 no running server at ${url} — DB synced; restart the server to register new handlers`
    );
  }
}

void (async () => {
  // main() reports verification failure via process.exitCode — only ever
  // ESCALATE the code here, never reset it back to 0.
  try {
    await main();
  } catch (error: unknown) {
    console.error(error);
    process.exitCode = 1;
  }
  try {
    await closeDatabase();
  } catch (error: unknown) {
    console.error('Failed to close database:', error);
    process.exitCode = 1;
  }
})();
