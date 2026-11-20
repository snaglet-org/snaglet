/**
 * The iMessage tools read Messages' database with the sqlite3 CLI. Before it runs the query,
 * sqlite3 executes its startup file ($XDG_CONFIG_HOME/sqlite3/sqliterc, else ~/.sqliterc),
 * which an agent can write with its shell, and `.shell` works there. So sqlite3 must skip
 * that file and never get the server's own environment (session and panel tokens, provider
 * keys). The real sqlite3 runs against a scratch database; the planted file sits under a
 * scratch XDG_CONFIG_HOME, which sqlite3 reads before the home folder's.
 */

import { execFileSync } from 'child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

interface Call {
  file: string;
  env: NodeJS.ProcessEnv | undefined;
}
const calls: Call[] = [];

// Records what each execFile call passed, then runs the real execFile. Jest's process.env is
// a sandbox copy a real child never sees, so a call without `env` gets it here explicitly:
// in the server, that call inherits everything this process has.
jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  const { promisify } = jest.requireActual<typeof import('util')>('util');
  const prepare = (args: unknown[]): unknown[] => {
    const at = args.findIndex(
      (arg) => typeof arg === 'object' && arg !== null && !Array.isArray(arg)
    );
    const options = at >= 0 ? (args[at] as { env?: NodeJS.ProcessEnv }) : undefined;
    calls.push({ file: String(args[0]), env: options?.env });
    if (options?.env) return args;
    const next = [...args];
    if (options) next[at] = { ...options, env: process.env };
    else next.splice(Array.isArray(args[1]) ? 2 : 1, 0, { env: process.env });
    return next;
  };
  const execFile = (...args: unknown[]) =>
    (actual.execFile as (...a: unknown[]) => unknown)(...prepare(args));
  Object.assign(execFile, {
    [promisify.custom]: (...args: unknown[]) =>
      (promisify(actual.execFile) as (...a: unknown[]) => Promise<unknown>)(...prepare(args)),
  });
  return { ...actual, execFile };
});

import { querySqliteJson } from '@server/services/ToolService/handlers/integrations/imessage/runners';

const SECRETS: Record<string, string> = {
  SNAGLET_AUTH_TOKEN: 'test-auth-token-aaaaaaaa',
  SNAGLET_PANEL_TOKEN: 'test-panel-token-aaaaaaaa',
  CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-key-aaaaaaaa',
  ANTHROPIC_API_KEY: 'test-provider-key-aaaaaaaa',
};

// The Messages database exists only on macOS, where /usr/bin/sqlite3 always does.
const describeMac = process.platform === 'darwin' ? describe : describe.skip;

let root: string;
let db: string;
let dump: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'snaglet-sqlite-env-'));
  db = path.join(root, 'chat.db');
  dump = path.join(root, 'sqliterc-ran.txt');
  execFileSync(
    '/usr/bin/sqlite3',
    ['-init', '/dev/null', db, 'CREATE TABLE t(x); INSERT INTO t VALUES (1);'],
    {
      stdio: 'ignore',
    }
  );
  // What an agent would plant: run a shell command before any query.
  const xdg = path.join(root, 'config');
  await mkdir(path.join(xdg, 'sqlite3'), { recursive: true });
  await writeFile(path.join(xdg, 'sqlite3', 'sqliterc'), `.shell env > '${dump}'\n`);
  for (const [key, value] of Object.entries({ ...SECRETS, XDG_CONFIG_HOME: xdg })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describeMac('iMessage sqlite3 queries', () => {
  it('skip the sqlite3 startup file, so a planted command never runs', async () => {
    const stdout = await querySqliteJson(db, 'SELECT x FROM t');
    expect(JSON.parse(stdout)).toEqual([{ x: 1 }]);
    await expect(stat(dump)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it("never hand sqlite3 the server's environment", async () => {
    calls.length = 0;
    await querySqliteJson(db, 'SELECT x FROM t');
    const call = calls.find((c) => path.basename(c.file) === 'sqlite3');
    expect(call?.env).toBeDefined();
    for (const key of Object.keys(SECRETS)) expect(call?.env?.[key]).toBeUndefined();
    expect(call?.env?.HOME).toBe(process.env.HOME);
  });
});
