import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildCommandEnv } from '@server/services/ToolService/lib/buildSafeEnv';

const execFileAsync = promisify(execFile);

/**
 * argv for `osascript`: one `-e` per script line, then `--` and the caller's
 * values. The script reads them from `argv` in its `on run argv` handler, so
 * contact names and message bodies never become AppleScript source or shell
 * text — no escaping to get wrong, and a value starting with `-` is still an
 * argument, not an osascript option.
 */
export function buildOsascriptArgs(
  scriptLines: readonly string[],
  argv: readonly string[]
): string[] {
  const args: string[] = [];
  for (const line of scriptLines) args.push('-e', line);
  args.push('--', ...argv);
  return args;
}

export async function runAppleScript(
  scriptLines: readonly string[],
  argv: readonly string[]
): Promise<string> {
  const { stdout } = await execFileAsync('osascript', buildOsascriptArgs(scriptLines, argv));
  return stdout;
}

/** Messages' chat database for the current macOS user. */
export function messagesDbPath(): string {
  return `${process.env['HOME']}/Library/Messages/chat.db`;
}

/**
 * Double single quotes so a value can sit inside an SQLite string literal.
 * SQLite has no backslash escapes, so `'` is the only terminator.
 */
export function sqlStringLiteralBody(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * The system sqlite3. A bare name would resolve through the user's login-shell PATH, which
 * can hold an older build without `-safe`; macOS 14 and later ship 3.43 or newer here.
 */
const SQLITE3 = process.platform === 'darwin' ? '/usr/bin/sqlite3' : 'sqlite3';

/**
 * argv for a read-only `sqlite3 -json` query. The SQL is one argv entry
 * starting with `SELECT`, so the CLI runs it as SQL, never as a dot-command.
 * `-init /dev/null` replaces the startup file sqlite3 would otherwise run
 * first ($XDG_CONFIG_HOME/sqlite3/sqliterc or ~/.sqliterc, which an agent can
 * write, and where `.shell` works); `-safe` turns off the dot-commands and SQL
 * functions that reach other files or run programs.
 */
export function buildSqliteArgs(dbPath: string, sql: string): string[] {
  return ['-init', '/dev/null', '-safe', '-readonly', '-json', dbPath, sql];
}

/** Runs with buildCommandEnv(), never the server's own environment. */
export async function querySqliteJson(dbPath: string, sql: string): Promise<string> {
  const { stdout } = await execFileAsync(SQLITE3, buildSqliteArgs(dbPath, sql), {
    maxBuffer: 16 * 1024 * 1024,
    env: buildCommandEnv(),
  });
  return stdout;
}
