/**
 * Ready-to-paste setup for an external MCP client, built
 * only from what the server reports (`McpConnectInfo`) and, in the one-time
 * view right after a key is minted, the key itself. Without a key every
 * snippet carries the {@link MCP_KEY_PLACEHOLDER}.
 *
 * - `claudeCode`: `claude mcp add <name> --env SNAGLET_MCP_KEY=<key> [--env SNAGLET_HOME=<home>] -- <snaglet> mcp`.
 *   SNAGLET_HOME is added only when the home is not the default `~/.snaglet`, and the
 *   server name is `snaglet-dev` for a dev Snaglet so it can sit beside the installed
 *   app's `snaglet`.
 * - `jsonConfig`: the `mcpServers` block Claude Desktop, Cursor and similar
 *   clients read.
 * - `httpUrl` / `httpHeader`: for clients that speak HTTP directly.
 *
 * Shell values are single-quoted when they hold anything but plain path
 * characters (a home with a space), as POSIX shells read them.
 */
import type { McpConnectInfo } from '@snaglet/shared/types';

export const MCP_KEY_PLACEHOLDER = '<your key>';

export interface McpConnectSnippets {
  /** The client-side server name: `snaglet`, or `snaglet-dev` for a dev Snaglet. */
  serverName: string;
  /** The `snaglet` command the snippets run: `snaglet`, or an absolute path. */
  command: string;
  /** No `snaglet` for this home was found: install it from Settings → Command line. */
  needsCli: boolean;
  claudeCode: string;
  jsonConfig: string;
  httpUrl: string;
  httpHeader: string;
}

const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One POSIX shell word: as is when plain, else single-quoted. */
function shellWord(value: string): string {
  return PLAIN.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function mcpConnectSnippets(info: McpConnectInfo, key: string | null): McpConnectSnippets {
  const token = key ?? MCP_KEY_PLACEHOLDER;
  const serverName = info.profile === 'dev' ? 'snaglet-dev' : 'snaglet';
  const command = info.cliOnPath ? 'snaglet' : (info.cliPath ?? 'snaglet');
  const env: Record<string, string> = { SNAGLET_MCP_KEY: token };
  if (!info.isDefaultHome) env.SNAGLET_HOME = info.snagletHome;

  // The placeholder stays readable (it is replaced by hand); real values are quoted as needed.
  const envArg = (name: string, value: string) =>
    value === MCP_KEY_PLACEHOLDER ? `${name}=${value}` : shellWord(`${name}=${value}`);
  const claudeCode = [
    'claude mcp add',
    serverName,
    ...Object.entries(env).map(([name, value]) => `--env ${envArg(name, value)}`),
    '--',
    shellWord(command),
    'mcp',
  ].join(' ');

  const jsonConfig = JSON.stringify(
    { mcpServers: { [serverName]: { command, args: ['mcp'], env } } },
    null,
    2
  );

  return {
    serverName,
    command,
    needsCli: !info.cliOnPath && info.cliPath === null,
    claudeCode,
    jsonConfig,
    httpUrl: info.mcpUrl,
    httpHeader: `Authorization: Bearer ${token}`,
  };
}
