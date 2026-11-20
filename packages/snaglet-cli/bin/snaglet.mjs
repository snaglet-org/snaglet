#!/usr/bin/env node
/**
 * snaglet — Snaglet command line.
 *
 * Commands:
 *   snaglet run <script> [args...]     Run a sandbox script (Node .js/.mjs/.ts or Python .py)
 *     --dry-run                   Print tool calls instead of executing them
 *     --verbose                   Log each tool call before executing
 *     --server <url>              Override Snaglet server URL
 *   snaglet scripts                    List scripts in the scripts directory
 *   snaglet create-script [name]       Create a new script (first run also sets up the dir)
 *   snaglet hook list                  List durable hook registrations
 *   snaglet hook <name> enable         Enable automatic event/schedule execution
 *   snaglet hook <name> disable        Disable automatic execution
 *   snaglet hook run <name>            Explicitly run a saved hook, even while disabled
 *
 * Script resolution for `snaglet run <script>`:
 *   1. Path as given (absolute or relative to cwd)
 *   2. Relative to the Snaglet scripts dir (~/.snaglet/scripts or $SNAGLET_HOME/scripts)
 *
 * Inside scripts:
 *   Node:    import { tools } from '@snaglet/sdk'
 *   Python:  from snaglet_sdk import tools
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

// Snaglet home + scripts dir resolution (CLI flag > env > config > default)
function resolveSnagletHome() {
  if (process.env.SNAGLET_HOME) return process.env.SNAGLET_HOME;
  try {
    const pointer = JSON.parse(readFileSync(join(homedir(), '.snaglet.json'), 'utf-8'));
    if (typeof pointer.homePath === 'string' && pointer.homePath.trim()) {
      return pointer.homePath.trim();
    }
  } catch {
    // Default below.
  }
  return join(homedir(), '.snaglet');
}

const SNAGLET_HOME = resolveSnagletHome();
const SCRIPTS_DIR = process.env.SNAGLET_SCRIPTS_DIR || join(SNAGLET_HOME, 'scripts');

// Packaged Snaglet uses a random loopback port and per-launch auth token. The
// desktop app publishes those ephemeral values in a mode-0600 file while it
// is running; explicit environment variables still take precedence.
// `snaglet mcp` outlives Snaglet restarts, so it gets the caller's own value (see
// mcp-bridge.mjs) rather than the session copy written below.
const CALLER_SERVER_URL = process.env.SNAGLET_SERVER_URL;
try {
  const session = JSON.parse(
    readFileSync(join(SNAGLET_HOME, 'runtime', 'desktop-cli-session.json'), 'utf-8')
  );
  if (!process.env.SNAGLET_SERVER_URL && typeof session.serverUrl === 'string') {
    process.env.SNAGLET_SERVER_URL = session.serverUrl;
  }
  if (!process.env.SNAGLET_SIDECAR_TOKEN && typeof session.sidecarToken === 'string') {
    process.env.SNAGLET_SIDECAR_TOKEN = session.sidecarToken;
  }
} catch {
  // Desktop is not running, or this is a normal development server.
}

// arg parsing
const rawArgs = process.argv.slice(2);
const command = rawArgs[0];

function usage(code = 0) {
  console.log(`snaglet — Snaglet command line

Usage:
  snaglet run <script> [args...] [--dry-run] [--verbose] [--server <url>]
  snaglet scripts
  snaglet create-script [name]
  snaglet hook list [--server <url>]
  snaglet hook <name> status|enable|disable|check [--server <url>]
  snaglet hook run <name> [--node <id>]... [--event <event>] [--server <url>]
  snaglet mcp [--server <url>] [--key <api-key>]

snaglet mcp bridges a stdio MCP client (Claude Code, Cursor, ...) to the Snaglet
server's /mcp endpoint. Auth: --key or the SNAGLET_MCP_KEY env var (mint a key
in Snaglet under MCP → Client connections). Example:
  claude mcp add snaglet --env SNAGLET_MCP_KEY=<key> -- snaglet mcp

Scripts live in ${SCRIPTS_DIR}
Node scripts:   import { tools } from '@snaglet/sdk'
Python scripts: from snaglet_sdk import tools`);
  process.exit(code);
}

if (!command || command === '--help' || command === '-h') usage();

// snaglet create-script

/** Extensions `snaglet create-script` can seed a starter for. `snaglet run` accepts more
 *  (.cjs/.mts), but there is no template for those — offering them here would
 *  create an empty file and call it a starter. */
const TEMPLATE_EXTENSIONS = ['.mjs', '.js', '.ts', '.py'];
const DEFAULT_EXTENSION = '.mjs';

/** What counts as "a script already exists here", matching `snaglet scripts`. */
const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.py'];

/** Windows reserves these regardless of extension; refusing them everywhere
 *  keeps a scripts dir portable between machines. */
const RESERVED_STEMS = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

function ensureScriptsDirManifest() {
  // '.ts'/'.js' scripts need "type": "module" so tsx/node treat them as ESM
  // (enables top-level await). '.mjs' works regardless.
  //
  // Exclusive create rather than exists-then-write: two `create-script` runs
  // can interleave, and a user may have hand-edited this manifest. EEXIST
  // means someone else's file is already there, which is exactly the outcome
  // we want — never overwrite it.
  const manifest = join(SCRIPTS_DIR, 'package.json');
  try {
    writeFileSync(
      manifest,
      JSON.stringify({ name: 'snaglet-scripts', type: 'module' }, null, 2) + '\n',
      {
        flag: 'wx',
      }
    );
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
}

function existingScripts() {
  try {
    // withFileTypes so a directory named `foo.js` does not count as a script.
    // It would otherwise flip the command into "name required" mode on what
    // is still an empty scripts dir. Symlinks report as neither file nor
    // directory here, so they are stat'd rather than guessed at.
    return readdirSync(SCRIPTS_DIR, { withFileTypes: true })
      .filter((entry) => {
        if (!SCRIPT_EXTENSIONS.includes(extname(entry.name))) return false;
        if (entry.isFile()) return true;
        if (!entry.isSymbolicLink()) return false;
        try {
          return statSync(join(SCRIPTS_DIR, entry.name)).isFile();
        } catch {
          return false; // dangling link — not a runnable script
        }
      })
      .map((entry) => entry.name);
  } catch {
    // Dir absent or unreadable: treat as empty.
    return [];
  }
}

function failCreateScript(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Turn a user-supplied name into a validated single filename.
 *
 * Everything here is a refusal rather than a repair: a name that needs fixing
 * is a name the user did not mean, and silently writing `foo_bar.mjs` when
 * they typed `foo/bar.mjs` puts the file somewhere they will not look for it.
 */
function resolveScriptFileName(rawName) {
  const raw = String(rawName);
  if (/[. ]$/.test(raw)) {
    failCreateScript(`Script name is not portable to Windows: ${raw}`);
  }
  const name = raw.trim();
  if (!name) failCreateScript('Script name cannot be empty.');
  if (isAbsolute(name)) {
    failCreateScript(
      `Give a file NAME, not a path: ${name}\nScripts are always created in ${SCRIPTS_DIR}`
    );
  }
  if (name.includes('/') || name.includes('\\')) {
    failCreateScript(
      `Script names cannot contain path separators: ${name}\nSubfolders are not supported; use a longer name instead.`
    );
  }
  if (name === '.' || name === '..' || name.startsWith('.')) {
    failCreateScript(`Script names cannot start with a dot: ${name}`);
  }
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) {
    failCreateScript(`Script name is not portable to Windows: ${name}`);
  }

  const ext = extname(name);
  if (ext && !TEMPLATE_EXTENSIONS.includes(ext)) {
    failCreateScript(
      `Unsupported script type "${ext}". Use one of: ${TEMPLATE_EXTENSIONS.join(', ')}`
    );
  }

  // Derive the final stem before validating it: a bare `con` takes the
  // default extension further down, and the reserved name is `con` whether or
  // not the user typed `.mjs`.
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  if (!stem) failCreateScript(`Script name is only an extension: ${name}`);
  if (RESERVED_STEMS.has(stem.toLowerCase())) {
    failCreateScript(`"${stem}" is a reserved filename on Windows. Choose another name.`);
  }

  return ext ? name : `${name}${DEFAULT_EXTENSION}`;
}

/** The starter body for a given extension. Python gets a different import
 *  because it uses the shipped `snaglet_sdk` module (see src/pylib/snaglet_sdk.py,
 *  which `snaglet run` puts on PYTHONPATH). */
function starterTemplate(fileName) {
  if (extname(fileName) === '.py') {
    return `from snaglet_sdk import tools

# Run with: snaglet run ${fileName} [--dry-run]
now = tools.get_current_datetime({})
print("Snaglet server says the time is:", now.get("iso", now))
`;
  }
  return `import { tools, snaglet } from '@snaglet/sdk';

// Run with: snaglet run ${fileName} [--dry-run]
const now = await tools.get_current_datetime({});
console.log('Snaglet server says the time is:', now?.iso ?? JSON.stringify(now));
console.log('script args:', snaglet.args);
`;
}

/**
 * `snaglet create-script [name]` creates a script. The directory and manifest are
 * prerequisites, created implicitly on every run.
 *
 * `name` is optional only on an empty scripts dir, where a working starter is
 * more useful than a usage error. Once anything exists, an omitted name is
 * ambiguous: the user wants *a* script, and we cannot guess which.
 */
if (command === 'create-script') {
  const operands = rawArgs.slice(1);

  // One name, or none. Silently dropping the rest would create a file the
  // user did not ask for while appearing to honor a command they did.
  if (operands.length > 1) {
    console.error(
      `snaglet create-script takes ONE name (got ${operands.length}: ${operands.join(' ')}).`
    );
    console.error('');
    console.error('Usage: snaglet create-script <name>');
    console.error('  Names cannot contain spaces or path separators.');
    process.exit(1);
  }

  const alreadyHasScripts = existingScripts().length > 0;
  // First contact (an empty scripts dir) always creates the hello.mjs
  // starter; a supplied name only selects a new script once the scripts dir
  // already contains one.
  const requested = !alreadyHasScripts ? 'hello.mjs' : operands[0];

  if (!requested) {
    console.error('snaglet create-script needs a name once you have scripts.');
    console.error('');
    console.error('Usage: snaglet create-script <name>');
    console.error(
      `  e.g. snaglet create-script daily-report        (creates daily-report${DEFAULT_EXTENSION})`
    );
    console.error(`       snaglet create-script cleanup.py`);
    console.error('');
    console.error(
      `Supported: ${TEMPLATE_EXTENSIONS.join(', ')}  ·  Scripts live in ${SCRIPTS_DIR}`
    );
    process.exit(1);
  }

  const fileName = resolveScriptFileName(requested ?? 'hello.mjs');

  // Idempotent prerequisites — safe on every run, including when the dir is
  // already set up and we are only adding a file.
  mkdirSync(SCRIPTS_DIR, { recursive: true });
  ensureScriptsDirManifest();

  const target = join(SCRIPTS_DIR, fileName);
  // Never clobber. A script is the user's own work; overwriting one to
  // "create" it is the single unrecoverable thing this command could do.
  //
  // Exclusive create rather than exists-then-write: the check and the write
  // are two syscalls, and anything that appears between them — a second `snaglet
  // create-script`, an editor, a sync client — would be silently destroyed by
  // the winner. `wx` makes the kernel arbitrate, so exactly one creator wins.
  try {
    writeFileSync(target, starterTemplate(fileName), { flag: 'wx' });
  } catch (err) {
    if (err?.code === 'EEXIST') {
      failCreateScript(`${target} already exists — not overwriting it.`);
    }
    throw err;
  }
  console.log(`Created ${target}`);
  if (!alreadyHasScripts) console.log(`Scripts directory ready: ${SCRIPTS_DIR}`);
  console.log(`Try: snaglet run ${fileName}`);
  process.exit(0);
}

// snaglet scripts
if (command === 'scripts' || command === 'list') {
  if (!existsSync(SCRIPTS_DIR)) {
    console.log(`No scripts directory yet. Run \`snaglet create-script\` to create ${SCRIPTS_DIR}`);
    process.exit(0);
  }
  const entries = readdirSync(SCRIPTS_DIR).filter((f) =>
    ['.js', '.mjs', '.cjs', '.ts', '.mts', '.py'].includes(extname(f))
  );
  if (entries.length === 0) {
    console.log(`No scripts in ${SCRIPTS_DIR}`);
  } else {
    console.log(`Scripts in ${SCRIPTS_DIR}:`);
    for (const f of entries) {
      const size = statSync(join(SCRIPTS_DIR, f)).size;
      console.log(`  ${f}  (${size} bytes)`);
    }
  }
  process.exit(0);
}

// snaglet mcp
if (command === 'mcp') {
  const mcpArgs = rawArgs.slice(1);
  const mcpFlags = { server: null, key: null };
  for (let i = 0; i < mcpArgs.length; i++) {
    const a = mcpArgs[i];
    if (a === '--server') mcpFlags.server = mcpArgs[++i];
    else if (a === '--key') mcpFlags.key = mcpArgs[++i];
    else {
      console.error(`snaglet mcp: unknown argument: ${a}\n`);
      usage(1);
    }
  }
  const { runMcpBridge } = await import(pathToFileURL(join(srcDir, 'mcp-bridge.mjs')).href);
  await runMcpBridge({
    ...mcpFlags,
    snagletHome: SNAGLET_HOME,
    envServerUrl: CALLER_SERVER_URL ?? null,
  });
  process.exit(0);
}

// snaglet hook
if (command === 'hook') {
  const hookArgs = rawArgs.slice(1);
  const isRun = hookArgs[0] === 'run';
  const isList = hookArgs[0] === 'list';
  const hookName = isRun ? hookArgs[1] : isList ? null : hookArgs[0];
  const action = isRun ? 'run' : isList ? 'list' : hookArgs[1];
  const allowedActions = new Set(['run', 'list', 'status', 'enable', 'disable', 'check']);
  if (!allowedActions.has(action) || (!isList && !hookName)) {
    console.error(
      'Usage: snaglet hook list | snaglet hook <name> status|enable|disable|check | snaglet hook run <name> [--node <id>]...'
    );
    process.exit(1);
  }
  const nodeIds = [];
  let eventName = null;
  let server = null;
  const flagStart = isRun ? 2 : isList ? 1 : 2;
  for (let i = flagStart; i < hookArgs.length; i++) {
    const arg = hookArgs[i];
    if (arg === '--node') nodeIds.push(hookArgs[++i]);
    else if (arg === '--event') eventName = hookArgs[++i];
    else if (arg === '--server') server = hookArgs[++i];
    else {
      console.error(`snaglet hook: unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (!server) {
    server = process.env.SNAGLET_SERVER_URL;
    if (!server) {
      try {
        const cfg = JSON.parse(readFileSync(join(SNAGLET_HOME, 'config.json'), 'utf-8'));
        if (typeof cfg.serverUrl === 'string') server = cfg.serverUrl;
      } catch {
        // No local config — use the normal development default.
      }
    }
  }
  server = (server || 'http://localhost:4001').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  const sidecarToken = process.env.SNAGLET_SIDECAR_TOKEN || process.env.SNAGLET_AUTH_TOKEN;
  if (sidecarToken) headers['X-Snaglet-Sidecar-Token'] = sidecarToken;
  try {
    const hookCliToken = readFileSync(
      join(SNAGLET_HOME, 'runtime', 'hook-cli-token'),
      'utf-8'
    ).trim();
    if (hookCliToken) headers['X-Snaglet-Hook-CLI-Token'] = hookCliToken;
  } catch {
    // The server may not have initialized hook CLI support yet.
  }
  const route =
    action === 'list'
      ? '/api/hooks/registry'
      : action === 'status'
        ? `/api/hooks/${encodeURIComponent(hookName)}/status`
        : action === 'run'
          ? `/api/hooks/${encodeURIComponent(hookName)}/run`
          : `/api/hooks/${encodeURIComponent(hookName)}/${action}`;
  const method = action === 'list' || action === 'status' ? 'GET' : 'POST';
  let response;
  try {
    response = await fetch(`${server}${route}`, {
      method,
      headers,
      ...(action === 'run'
        ? {
            body: JSON.stringify({
              ...(nodeIds.length ? { nodeIds } : {}),
              ...(eventName ? { eventName } : {}),
            }),
          }
        : {}),
    });
  } catch (err) {
    console.error(`snaglet hook ${action}: cannot reach ${server} (${err.message})`);
    process.exit(1);
  }
  const envelope = await response.json().catch(() => null);
  if (!response.ok || !envelope?.success) {
    console.error(
      `snaglet hook ${action}: ${envelope?.error?.message ?? envelope?.error ?? `HTTP ${response.status}`}`
    );
    process.exit(1);
  }
  console.log(JSON.stringify(envelope.data, null, 2));
  process.exit(action === 'run' && !envelope.data.runs.every((run) => run.result.ok) ? 1 : 0);
}

if (command !== 'run') {
  console.error(`Unknown command: ${command}\n`);
  usage(1);
}

// snaglet run
const runArgs = rawArgs.slice(1);
const flags = { dryRun: false, verbose: false, server: null };
const positional = [];
for (let i = 0; i < runArgs.length; i++) {
  const a = runArgs[i];
  if (a === '--') {
    positional.push(...runArgs.slice(i + 1));
    break;
  }
  if (a === '--dry-run') flags.dryRun = true;
  else if (a === '--verbose') flags.verbose = true;
  else if (a === '--server') flags.server = runArgs[++i];
  else positional.push(a);
}

const scriptArg = positional[0];
if (!scriptArg) {
  console.error('snaglet run: script path required\n');
  usage(1);
}

// resolve script: as-given, then relative to scripts dir
let scriptPath = isAbsolute(scriptArg) ? scriptArg : resolve(process.cwd(), scriptArg);
if (!existsSync(scriptPath)) {
  const inScriptsDir = join(SCRIPTS_DIR, scriptArg);
  if (existsSync(inScriptsDir)) {
    scriptPath = inScriptsDir;
  } else {
    console.error(`snaglet run: script not found: ${scriptArg}`);
    console.error(`  looked in: ${resolve(process.cwd(), scriptArg)}`);
    console.error(`  and:       ${inScriptsDir}`);
    process.exit(1);
  }
}

const ext = extname(scriptPath);
const scriptArgs = positional.slice(1);

const childEnv = {
  // allowlist — do NOT inherit the full parent env into scripts
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  TMPDIR: process.env.TMPDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  SYSTEMROOT: process.env.SYSTEMROOT,
  LANG: process.env.LANG,
  TERM: process.env.TERM,
  SNAGLET_HOME,
  SNAGLET_SCRIPTS_DIR: SCRIPTS_DIR,
  ...(process.env.SNAGLET_SERVER_URL ? { SNAGLET_SERVER_URL: process.env.SNAGLET_SERVER_URL } : {}),
  ...(process.env.SNAGLET_SIDECAR_TOKEN
    ? { SNAGLET_SIDECAR_TOKEN: process.env.SNAGLET_SIDECAR_TOKEN }
    : {}),
  ...(flags.server ? { SNAGLET_SERVER_URL: flags.server } : {}),
  ...(flags.dryRun ? { SNAGLET_DRY_RUN: '1' } : {}),
  ...(flags.verbose ? { SNAGLET_VERBOSE: '1' } : {}),
};

let child;
if (ext === '.py') {
  const pylib = join(srcDir, 'pylib');
  child = spawn(process.platform === 'win32' ? 'python' : 'python3', [scriptPath, ...scriptArgs], {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...childEnv,
      PYTHONPATH: process.env.PYTHONPATH ? `${pylib}${delimiter}${process.env.PYTHONPATH}` : pylib,
      PYTHONUNBUFFERED: '1',
    },
  });
} else if (['.js', '.mjs', '.cjs', '.ts', '.mts'].includes(ext)) {
  // ensure ESM semantics for .ts/.js scripts living in the scripts dir
  if (
    (ext === '.ts' || ext === '.js') &&
    dirname(scriptPath) === SCRIPTS_DIR &&
    existsSync(SCRIPTS_DIR)
  ) {
    ensureScriptsDirManifest();
  }
  const registerUrl = join(srcDir, 'register.mjs');
  const nodeArgs = ['--import', registerUrl];
  // TypeScript scripts: try tsx if available (resolved from PATH); otherwise error clearly
  if (ext === '.ts' || ext === '.mts') {
    nodeArgs.push('--import', 'tsx');
  }
  nodeArgs.push(scriptPath, ...scriptArgs);
  child = spawn(process.execPath, nodeArgs, {
    stdio: 'inherit',
    env: childEnv,
    windowsHide: true,
  });
} else {
  console.error(
    `snaglet run: unsupported script type "${ext}" (use .js, .mjs, .cjs, .ts, .mts, or .py)`
  );
  process.exit(1);
}

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`snaglet run: script terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error(`snaglet run: failed to start: ${err.message}`);
  process.exit(1);
});
