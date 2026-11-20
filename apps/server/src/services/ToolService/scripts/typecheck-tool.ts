/**
 * typecheck-tool — Scoped TypeScript check for a single tool folder.
 *
 * Usage:
 *   pnpm typecheck:tool <tool-name>
 *
 * Why this exists: full-project `tsc --noEmit` (the `typecheck` script) is the
 * source of truth, but it can exceed CI/agent-runner timeouts on this repo.
 * This provides a fast, scoped gate that type-checks only a single tool folder
 * (tool.ts / definition.ts / etc.) plus its transitive imports, against the
 * project's tsconfig (so path aliases like @server/* and @snaglet/shared/* resolve).
 *
 * It is a build-loop gate to catch obvious type errors before sync — not a
 * substitute for the full-project check. It works by writing a temporary
 * tsconfig that extends the real one and narrows `include` to the tool folder,
 * which keeps compiler options + path mappings intact while avoiding a full
 * src-tree crawl.
 */
import crossSpawn from 'cross-spawn';
import { existsSync, readdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findToolFolder, TOOLS_DIR } from './lib/tool-metadata';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// apps/server root (this script lives at src/services/ToolService/scripts)
const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const BASE_TSCONFIG = path.join(SERVER_ROOT, 'tsconfig.json');

function fail(msg: string): never {
  console.error(`\u274c typecheck:tool — ${msg}`);
  process.exit(1);
}

const name = process.argv[2];
if (!name) {
  fail('missing tool name. Usage: pnpm typecheck:tool <tool-name>');
}

const entry = findToolFolder(name);
if (!entry) {
  fail(`tool folder not found for "${name}" under ${TOOLS_DIR}`);
}

if (!existsSync(BASE_TSCONFIG)) {
  fail(`base tsconfig not found at ${BASE_TSCONFIG}`);
}

const tsFiles = readdirSync(entry.absPath).filter((f) => f.endsWith('.ts'));
if (tsFiles.length === 0) {
  fail(`no .ts files found in ${entry.absPath}`);
}

console.log(`\u2192 typecheck:tool ${entry.toolId} (${tsFiles.length} file(s))`);

// Write a temporary tsconfig at SERVER_ROOT so its relative `extends` and
// path-alias baseUrl resolve identically to the real one. It narrows `include`
// to just this tool folder; tsc still resolves transitive imports for
// type-correctness, but does not enumerate the entire src tree as roots.
const tmpConfigPath = path.join(SERVER_ROOT, `tsconfig.tool-${entry.toolId}.tmp.json`);
const includeGlob = path.relative(SERVER_ROOT, entry.absPath).split(path.sep).join('/');
const tmpConfig = {
  extends: './tsconfig.json',
  compilerOptions: { noEmit: true },
  include: [`${includeGlob}/**/*.ts`],
};

let status = 1;
try {
  writeFileSync(tmpConfigPath, JSON.stringify(tmpConfig, null, 2));
  const result = crossSpawn.sync('npx', ['tsc', '--project', tmpConfigPath], {
    cwd: SERVER_ROOT,
    stdio: 'inherit',
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.error) {
    fail(`failed to invoke tsc: ${result.error.message}`);
  }
  status = result.status ?? 1;
} finally {
  // Always clean up the temp tsconfig, even on type errors.
  try {
    rmSync(tmpConfigPath, { force: true });
  } catch {
    /* ignore cleanup failure */
  }
}

if (status !== 0) {
  console.error(`\u274c typecheck:tool — type errors in ${entry.toolId}`);
  process.exit(status);
}

console.log(`\u2705 typecheck:tool ${entry.toolId} — no type errors`);
