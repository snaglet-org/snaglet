/**
 * mcpTransport — constructs the SDK client transport for a resolved server
 * config. A pure factory (config + already-substituted env/headers in, transport
 * out); it opens nothing, so the connection lifecycle stays in McpService.
 *
 * The transport classes are imported here as values (for construction) and the
 * shared `McpClientTransport` union type is derived from them, so the MCP-SDK
 * subpath imports stay concentrated in the two modules that truly need them
 * (this factory + the `new Client(...)` in McpService).
 */

import { delimiter } from 'node:path';
import { getErrorMessage } from '@snaglet/shared/utils';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveLoginShellPath, shellPath } from '@server/services/ToolService/lib/loginShellPath';
import type { McpServerConfig } from './mcpTypes';

/**
 * Start a stdio server from Snaglet's installed copy instead of its configured
 * command (see mcpInstaller). Env and cwd are the configured server's own.
 */
export interface DirectLaunch {
  command: string;
  args: string[];
  /** The install's node_modules/.bin, put first on PATH as npx does. */
  binDir: string;
}

/**
 * The client transports McpService drives. Both the stdio and Streamable HTTP
 * transports expose the same `close()` / `onclose` / `onerror` surface, so the
 * connection machinery is transport-agnostic.
 */
export type McpClientTransport = StdioClientTransport | StreamableHTTPClientTransport;

export function buildTransport(
  config: McpServerConfig,
  resolvedEnv: Record<string, string>,
  resolvedHeaders: Record<string, string>,
  direct?: DirectLaunch | null
): McpClientTransport {
  if (config.transport === 'stdio') {
    if (!config.command) {
      throw new Error(`[McpService] stdio server '${config.id}' has no command`);
    }
    const env = withLoginPath(resolvedEnv);
    if (direct) {
      return new StdioClientTransport({
        command: direct.command,
        args: direct.args,
        env: { ...env, PATH: env.PATH ? `${direct.binDir}${delimiter}${env.PATH}` : direct.binDir },
      });
    }
    return new StdioClientTransport({ command: config.command, args: config.args, env });
  }
  if (config.transport === 'http') {
    if (!config.url) {
      throw new Error(`[McpService] http server '${config.id}' has no url`);
    }
    // `resolvedHeaders` carries auth (e.g. Authorization) with any
    // `${credential}` / `${cred.field}` placeholders already substituted.
    // They ride on requestInit so every HTTP request the transport makes
    // (POST for sends + SSE GET for receives) is authenticated.
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit:
        Object.keys(resolvedHeaders).length > 0 ? { headers: resolvedHeaders } : undefined,
    });
  }
  // The deprecated SSE-only transport is not supported; surface a clear, non-fatal error.
  throw new Error(
    `[McpService] transport '${config.transport}' not yet supported for '${config.id}'`
  );
}

/**
 * Wait (bounded, once per process) for the login-shell PATH lookup started at
 * boot, so an early stdio start doesn't race it and fall back to launchd's PATH.
 */
export function loginPathReady(): Promise<void> {
  return resolveLoginShellPath();
}

/**
 * Give a stdio server the user's login-shell PATH. Snaglet.app launched by macOS
 * inherits launchd's minimal PATH, so `npx`/`uvx` from nvm or Homebrew were not
 * found (`spawn npx ENOENT`). An explicit PATH in the server's own env wins.
 */
export function withLoginPath(env: Record<string, string>): Record<string, string> {
  if (env.PATH) return env;
  const path = shellPath();
  return path ? { ...env, PATH: path } : env;
}

/**
 * A readable reason for a failed start. A missing command surfaces from the
 * spawn as a raw `ENOENT`; say which command and what to do instead.
 */
export function describeConnectError(
  config: McpServerConfig,
  err: unknown,
  command: string | null = config.command
): string {
  const code = (err as { code?: unknown } | null)?.code;
  const message = getErrorMessage(err);
  if (config.transport === 'stdio' && (code === 'ENOENT' || /\bENOENT\b/.test(message))) {
    return `Command '${command ?? ''}' was not found on PATH. Set its full path in the server config.`;
  }
  return message;
}
