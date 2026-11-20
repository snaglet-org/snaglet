/**
 * Guard: no child process the server starts inherits or is handed the server's own
 * environment (session, panel and shutdown tokens, the credential encryption key, the
 * export grant key, provider keys) unless the call is on the reviewed list below.
 *
 * Every child_process / cross-spawn call in apps/server/src must pass an explicit `env:`
 * that is not `process.env` and does not spread it; buildCommandEnv() (ToolService/lib/
 * buildSafeEnv.ts) is the usual choice. A call without `env:` inherits everything. The
 * shared helpers (runExecFile, runExecFileBuffer) default to buildCommandEnv(), so only an
 * explicit `process.env` is flagged there. A spawn function passed around by reference
 * (an injectable `spawn`) cannot be checked at its call site, so it needs a review too.
 * Developer scripts (src/scripts, ToolService/scripts) run from a terminal, never from
 * Snaglet, and are skipped.
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import ts from 'typescript';

const REPO_ROOT = path.join(__dirname, '../../../..');
const SERVER_SRC = 'apps/server/src';
const SKIPPED_DIRS = ['apps/server/src/scripts/', 'apps/server/src/services/ToolService/scripts/'];

const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const SPAWN_FUNCTIONS = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]);
const SHARED_HELPERS = new Set(['runExecFile', 'runExecFileBuffer']);

interface Reviewed {
  /** Under apps/server/src. */
  file: string;
  /** A piece of the call's source text that picks out the reviewed call. */
  call: string;
  reason: string;
}

const review = (file: string, calls: string[], reason: string): Reviewed[] =>
  calls.map((call) => ({ file: `${SERVER_SRC}/${file}`, call, reason }));

const SYSTEM_TOOL = 'OS program, fixed script or argv; runs no file an agent can write';
const SNAGLET_HELPER_BUILD =
  "swiftc probe and build.sh of Snaglet's own helper when its binary is missing";
const SNAGLET_HELPER = "Snaglet's own helper binary with fixed args, through an injectable spawn";

/**
 * Calls that may inherit the server's environment, and why. In Snaglet.app the inherited PATH is
 * launchd's (/usr/bin:/bin:/usr/sbin:/sbin), so bare names resolve to system programs.
 * Keep it short: a new call passes `env: buildCommandEnv()` (or a narrower env) instead.
 */
const REVIEWED: Reviewed[] = [
  ...review(
    'routes/server.ts',
    ['spawn(cmd, args'],
    'folder picker; zenity needs the desktop session'
  ),
  ...review(
    'routes/skills.ts',
    ['spawn(cmd, args'],
    'reveal in Finder / xdg-open; needs the desktop session'
  ),
  ...review(
    'services/ExportService/writeTarget.ts',
    ["'powershell.exe'"],
    'Windows ACL copy, fixed -NoProfile command; PowerShell needs profile variables buildCommandEnv drops'
  ),
  ...review('utils/processes.ts', ['taskkill'], SYSTEM_TOOL),
  ...review('services/ProviderChatService/providers/claudeCliAuth.ts', ["'security'"], SYSTEM_TOOL),
  ...review(
    'services/ToolService/handlers/integrations/imessage/runners.ts',
    ["'osascript'"],
    SYSTEM_TOOL
  ),
  ...review(
    'services/ToolService/tools/system/computer/tool.ts',
    ["'osascript'", "'screencapture'"],
    SYSTEM_TOOL
  ),
  ...review('services/customHooks/systemTrash.ts', ["'osascript'"], SYSTEM_TOOL),
  ...review(
    'services/vision/VisionSnapshotService.ts',
    ["'/usr/sbin/screencapture'", "'/usr/bin/sips'"],
    SYSTEM_TOOL
  ),
  ...review('services/shellJobs/orphanReaper.ts', ["'ps'"], SYSTEM_TOOL),
  ...review('services/voice/appleSidecarCleanup.ts', ["'pgrep'"], SYSTEM_TOOL),
  ...review('services/voice/fetchArchive.ts', ["'tar'"], SYSTEM_TOOL),
  ...review(
    'services/systemActivity/fullWake.ts',
    ['COMMAND_TIMEOUT_MS'],
    `pmset, ioreg: ${SYSTEM_TOOL}`
  ),
  ...review(
    'services/ToolService/lib/gitUserEmail.ts',
    ["'git'"],
    '`git config user.email` only reads config; no hooks, fsmonitor or helpers run'
  ),
  ...review(
    'services/ProviderChatService/appleChat/appleChatResolver.ts',
    ["'swiftc'", "'bash'"],
    SNAGLET_HELPER_BUILD
  ),
  ...review('services/nlp/nlpHelperResolver.ts', ["'swiftc'", "'bash'"], SNAGLET_HELPER_BUILD),
  ...review('services/voice/sttEngineResolver.ts', ["'swiftc'", "'bash'"], SNAGLET_HELPER_BUILD),
  ...review('services/voice/ttsEngineResolver.ts', ["'bash'"], SNAGLET_HELPER_BUILD),
  ...review(
    'services/ProviderChatService/appleChat/appleChatEngine.ts',
    ['opts.spawn ?? spawn'],
    SNAGLET_HELPER
  ),
  ...review('services/nlp/NlpHelperClient.ts', ['opts.spawn ?? spawn'], SNAGLET_HELPER),
  ...review('services/voice/appleSttEngine.ts', ['opts.spawn ?? spawn'], SNAGLET_HELPER),
  ...review('services/voice/appleTtsEngine.ts', ['opts.spawn ?? spawn'], SNAGLET_HELPER),
];

interface Finding {
  file: string;
  line: number;
  problem: string;
  text: string;
}

function serverFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.some((skipped) => `${rel}/`.startsWith(skipped))) {
        out.push(...serverFiles(rel));
      }
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(rel);
    }
  }
  return out;
}

function isProcessEnv(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'env' &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process'
  );
}

/** Whether an `env:` value is the server's environment or a spread of it. */
function leaksProcessEnv(value: ts.Expression): boolean {
  if (isProcessEnv(value)) return true;
  return (
    ts.isObjectLiteralExpression(value) &&
    value.properties.some((p) => ts.isSpreadAssignment(p) && isProcessEnv(p.expression))
  );
}

function envProperty(options: ts.ObjectLiteralExpression): ts.ObjectLiteralElementLike | null {
  return (
    options.properties.find(
      (p) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        ts.isIdentifier(p.name) &&
        p.name.text === 'env'
    ) ?? null
  );
}

function scan(file: string): Finding[] {
  const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
  if (!/['"](node:)?child_process['"]|['"]cross-spawn['"]|runExecFile/.test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const add = (node: ts.Node, problem: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    findings.push({ file, line, problem, text: node.getText(source) });
  };

  const spawners = new Set<string>(); // local names of spawn functions
  const namespaces = new Set<string>(); // `import * as cp` / `import cp`
  const crossSpawn = new Set<string>(); // cross-spawn default import: callable and `.sync`
  const helpers = new Set<string>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const from = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (CHILD_PROCESS_MODULES.has(from)) {
      if (clause.name) namespaces.add(clause.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const spec of bindings.elements) {
          const original = (spec.propertyName ?? spec.name).text;
          if (!spec.isTypeOnly && SPAWN_FUNCTIONS.has(original)) spawners.add(spec.name.text);
        }
      }
    } else if (from === 'cross-spawn') {
      if (clause.name) crossSpawn.add(clause.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) crossSpawn.add(bindings.name.text);
    } else if (from.endsWith('/_shared') && bindings && ts.isNamedImports(bindings)) {
      for (const spec of bindings.elements) {
        const original = (spec.propertyName ?? spec.name).text;
        if (SHARED_HELPERS.has(original)) helpers.add(spec.name.text);
      }
    }
  }
  if (
    /\brequire\(\s*['"](node:)?child_process['"]|\bimport\(\s*['"](node:)?child_process['"]/.test(
      text
    )
  ) {
    findings.push({ file, line: 0, problem: 'loads child_process dynamically', text: '' });
  }

  const isSpawnFunction = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && spawners.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ((namespaces.has(node.expression.text) && SPAWN_FUNCTIONS.has(node.name.text)) ||
        (crossSpawn.has(node.expression.text) && node.name.text === 'sync')));

  // `const run = promisify(execFile)` makes `run` a spawn function too.
  const collectAliases = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      /(^|\.)promisify$/.test(node.initializer.expression.getText(source)) &&
      node.initializer.arguments[0] &&
      isSpawnFunction(node.initializer.arguments[0])
    ) {
      spawners.add(node.name.text);
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(source);

  const checkedArguments = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isHelper = ts.isIdentifier(callee) && helpers.has(callee.text);
      const isSpawn =
        isSpawnFunction(callee) || (ts.isIdentifier(callee) && crossSpawn.has(callee.text));
      const isPromisify = /(^|\.)promisify$/.test(callee.getText(source));
      if (isPromisify) node.arguments.forEach((arg) => checkedArguments.add(arg));
      if (isSpawn || isHelper) {
        checkedArguments.add(callee);
        if (ts.isPropertyAccessExpression(callee)) checkedArguments.add(callee.expression);
        const options = node.arguments.find(ts.isObjectLiteralExpression);
        const env = options ? envProperty(options) : null;
        if (env && ts.isPropertyAssignment(env) && leaksProcessEnv(env.initializer)) {
          add(node, 'passes process.env');
        } else if (!env && isSpawn) {
          add(node, 'has no env, so it inherits process.env');
        }
      }
    }
    if (
      (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) &&
      isProcessEnv(node.expression) &&
      !(ts.isObjectLiteralExpression(node.parent) && isInsideSpawnCall(node.parent))
    ) {
      add(node.parent, 'spreads process.env into a new object');
    }
    if (
      ts.isIdentifier(node) &&
      (spawners.has(node.text) || crossSpawn.has(node.text)) &&
      !checkedArguments.has(node) &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isImportClause(node.parent) &&
      !ts.isTypeQueryNode(node.parent) &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
      !ts.isPropertySignature(node.parent)
    ) {
      add(node.parent, 'passes a spawn function by reference');
    }
    ts.forEachChild(node, visit);
  };

  /** A spread inside a spawn call's own options is reported once, by the call check. */
  const isInsideSpawnCall = (node: ts.Node): boolean => {
    for (let at: ts.Node | undefined = node; at; at = at.parent) {
      if (
        ts.isCallExpression(at) &&
        (isSpawnFunction(at.expression) ||
          (ts.isIdentifier(at.expression) &&
            (crossSpawn.has(at.expression.text) || helpers.has(at.expression.text))))
      ) {
        return true;
      }
    }
    return false;
  };

  visit(source);
  return findings;
}

describe('child process environment guard', () => {
  const findings = serverFiles(SERVER_SRC).flatMap(scan);
  const reviewedFor = (finding: Finding): Reviewed | undefined =>
    REVIEWED.find((entry) => entry.file === finding.file && finding.text.includes(entry.call));

  it('finds the spawn calls it is meant to check', () => {
    // A scanner that silently matches nothing would pass everything below.
    expect(findings.length).toBeGreaterThan(5);
  });

  it("no child process inherits or is handed the server's environment unreviewed", () => {
    const unreviewed = findings
      .filter((finding) => !reviewedFor(finding))
      .map((f) => `${f.file}:${f.line} ${f.problem}: ${f.text.split('\n')[0]}`);
    expect(unreviewed).toEqual([]);
  });

  it('every reviewed entry still matches a call', () => {
    const stale = REVIEWED.filter(
      (entry) => !findings.some((f) => f.file === entry.file && f.text.includes(entry.call))
    ).map((entry) => `${entry.file}: ${entry.call}`);
    expect(stale).toEqual([]);
  });
});
