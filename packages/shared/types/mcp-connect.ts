/**
 * GET /api/mcp-keys/connect-info: what an external MCP client needs to reach
 * this Snaglet, as the server knows it. The Settings pane builds
 * its ready-to-paste setup from it. It carries no secret: the MCP key itself
 * is shown only once, in the mint response.
 */

/** Which Snaglet answered: the installed app, or a dev / preview server. */
export type McpConnectProfile = 'production' | 'dev';

export interface McpConnectInfo {
  /** This Snaglet's home directory (SNAGLET_HOME), absolute. */
  snagletHome: string;
  /** True when the home is the default `~/.snaglet` (clients then need no SNAGLET_HOME). */
  isDefaultHome: boolean;
  profile: McpConnectProfile;
  /**
   * Absolute path of a `snaglet` command that runs the Snaglet CLI for this home: the
   * one on the user's PATH, else the installed Snaglet launcher, else (a dev
   * server) the checkout's `packages/snaglet-cli/bin/snaglet.mjs`. Null when none is
   * found (install it in Settings → Command line).
   */
  cliPath: string | null;
  /** `snaglet` on the user's PATH runs the CLI for this home (snippets can say `snaglet`). */
  cliOnPath: boolean;
  /** The port this server listens on now (the installed app picks a new one every launch). */
  port: number;
  /** `http://127.0.0.1:<port>/mcp`. */
  mcpUrl: string;
}
