import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'apps/server/src/index.ts'), 'utf8');
const backgroundStart = source.indexOf('async function runBackgroundInit()');
const serverStart = source.indexOf('async function startServer()');
const watchdogStart = source.indexOf('// Parent watchdog');
const backgroundInit = source.slice(backgroundStart, serverStart);
const startServer = source.slice(serverStart, watchdogStart);
const listenStart = startServer.indexOf('httpServer.listen(');
const beforeListen = startServer.slice(0, listenStart);
const listenAndAfter = startServer.slice(listenStart);

describe('server startup phase boundary', () => {
  it('finishes every serving prerequisite before opening the port', () => {
    expect(backgroundStart).toBeGreaterThan(-1);
    expect(serverStart).toBeGreaterThan(backgroundStart);
    expect(listenStart).toBeGreaterThan(-1);

    for (const prerequisite of [
      /await ensureSnagletHome\(\)/,
      /await preMigrationBackupIfNeeded\(\)/,
      /await initializeDatabase\(\)/,
      /await ensureBuiltinCatalog\(/,
      /await Users\.getOrCreateLocalUser\(\)/,
      /registerActorMemberResolver\(\)/,
    ]) {
      expect(beforeListen).toMatch(prerequisite);
    }
  });

  it('prunes automatic snapshots only after the migrations succeeded', () => {
    const snapshot = beforeListen.search(/await preMigrationBackupIfNeeded\(\)/);
    const migrate = beforeListen.search(/await initializeDatabase\(\)/);
    const prune = beforeListen.search(
      /await pruneAutomaticSnapshots\(\{ justTaken: preMigration \}\)/
    );
    expect(snapshot).toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(snapshot);
    expect(prune).toBeGreaterThan(migrate);
  });

  it('starts slow, non-serving work only from the listen callback', () => {
    for (const deferred of [
      /bootstrapLocalEmbedder\(/,
      /Runs\.markAllRunningFailed\(/,
      /startEmbeddingWorker\(\)/,
      /ensureStartupEmbeddingBackfill\(\)/,
      /toolRegistry\.load\(\)/,
      /startCustomToolScanner\(\)/,
      /startHookScanner\(\)/,
      /mcpService\.loadConfig\(\)/,
    ]) {
      expect(beforeListen).not.toMatch(deferred);
      expect(backgroundInit).toMatch(deferred);
    }

    expect(listenAndAfter).toMatch(/void runBackgroundInit\(\)\.catch\(/);
  });

  it('keeps background initialization failures from rejecting the listening server', () => {
    expect(backgroundInit).toMatch(/markAllRunningFailed failed \(non-fatal\)/);
    expect(backgroundInit).toMatch(/load\/sync failed \(non-fatal\)/);
    expect(backgroundInit).toMatch(/scanner start failed/);
    expect(backgroundInit).toMatch(/MCP initialization failed \(non-fatal\)/);
    expect(listenAndAfter).toMatch(/background init crashed/);
  });
});
