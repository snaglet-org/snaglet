import { describe, expect, it } from 'vitest';
import type { McpConnectInfo } from '@snaglet/shared/types';
import { MCP_KEY_PLACEHOLDER, mcpConnectSnippets } from './mcpConnectSnippets';

const KEY = `snaglet_mcp_0a1b2c3d_${'ab'.repeat(24)}`;

const production: McpConnectInfo = {
  snagletHome: '/Users/test-user/.snaglet',
  isDefaultHome: true,
  profile: 'production',
  cliPath: '/Users/test-user/.local/bin/snaglet',
  cliOnPath: true,
  port: 51234,
  mcpUrl: 'http://127.0.0.1:51234/mcp',
};

const dev: McpConnectInfo = {
  snagletHome: '/Users/test-user/.snaglet-dev',
  isDefaultHome: false,
  profile: 'dev',
  cliPath: '/Users/test-user/code/snaglet/packages/snaglet-cli/bin/snaglet.mjs',
  cliOnPath: false,
  port: 4001,
  mcpUrl: 'http://127.0.0.1:4001/mcp',
};

describe('mcpConnectSnippets', () => {
  it('production, default home, snaglet on PATH: no SNAGLET_HOME, plain `snaglet`', () => {
    const snippets = mcpConnectSnippets(production, KEY);
    expect(snippets).toMatchObject({ serverName: 'snaglet', command: 'snaglet', needsCli: false });
    expect(snippets.claudeCode).toBe(
      `claude mcp add snaglet --env SNAGLET_MCP_KEY=${KEY} -- snaglet mcp`
    );
    expect(JSON.parse(snippets.jsonConfig)).toEqual({
      mcpServers: { snaglet: { command: 'snaglet', args: ['mcp'], env: { SNAGLET_MCP_KEY: KEY } } },
    });
    expect(snippets.jsonConfig).toContain('\n  "mcpServers": {\n'); // pretty-printed
    expect(snippets.httpUrl).toBe('http://127.0.0.1:51234/mcp');
    expect(snippets.httpHeader).toBe(`Authorization: Bearer ${KEY}`);
  });

  it('a dev home adds SNAGLET_HOME, names the server snaglet-dev and uses the absolute CLI path', () => {
    const snippets = mcpConnectSnippets(dev, KEY);
    expect(snippets).toMatchObject({ serverName: 'snaglet-dev', command: dev.cliPath });
    expect(snippets.claudeCode).toBe(
      `claude mcp add snaglet-dev --env SNAGLET_MCP_KEY=${KEY} --env SNAGLET_HOME=/Users/test-user/.snaglet-dev -- ` +
        '/Users/test-user/code/snaglet/packages/snaglet-cli/bin/snaglet.mjs mcp'
    );
    expect(JSON.parse(snippets.jsonConfig)).toEqual({
      mcpServers: {
        'snaglet-dev': {
          command: dev.cliPath,
          args: ['mcp'],
          env: { SNAGLET_MCP_KEY: KEY, SNAGLET_HOME: '/Users/test-user/.snaglet-dev' },
        },
      },
    });
  });

  it('the CLI off PATH in production: its absolute path', () => {
    const snippets = mcpConnectSnippets({ ...production, cliOnPath: false }, KEY);
    expect(snippets.claudeCode).toBe(
      `claude mcp add snaglet --env SNAGLET_MCP_KEY=${KEY} -- /Users/test-user/.local/bin/snaglet mcp`
    );
    expect(JSON.parse(snippets.jsonConfig).mcpServers.snaglet.command).toBe(
      '/Users/test-user/.local/bin/snaglet'
    );
  });

  it('no CLI found: `snaglet`, flagged so the pane says to install it', () => {
    const snippets = mcpConnectSnippets({ ...production, cliOnPath: false, cliPath: null }, KEY);
    expect(snippets).toMatchObject({ command: 'snaglet', needsCli: true });
    expect(snippets.claudeCode).toMatch(/ -- snaglet mcp$/);
  });

  it('quotes a home and a CLI path with spaces or quotes for the shell; JSON keeps them raw', () => {
    const odd: McpConnectInfo = {
      ...dev,
      snagletHome: "/Users/Test User/Snaglet's home",
      cliPath: '/Users/Test User/code/snaglet/packages/snaglet-cli/bin/snaglet.mjs',
    };
    const snippets = mcpConnectSnippets(odd, KEY);
    expect(snippets.claudeCode).toBe(
      `claude mcp add snaglet-dev --env SNAGLET_MCP_KEY=${KEY} --env 'SNAGLET_HOME=/Users/Test User/Snaglet'\\''s home' -- ` +
        "'/Users/Test User/code/snaglet/packages/snaglet-cli/bin/snaglet.mjs' mcp"
    );
    const server = JSON.parse(snippets.jsonConfig).mcpServers['snaglet-dev'];
    expect(server.command).toBe(
      '/Users/Test User/code/snaglet/packages/snaglet-cli/bin/snaglet.mjs'
    );
    expect(server.env.SNAGLET_HOME).toBe("/Users/Test User/Snaglet's home");
  });

  it('without a key every snippet carries the placeholder and no key', () => {
    for (const info of [production, dev]) {
      const snippets = mcpConnectSnippets(info, null);
      expect(snippets.claudeCode).toContain(`--env SNAGLET_MCP_KEY=${MCP_KEY_PLACEHOLDER} `);
      expect(
        JSON.parse(snippets.jsonConfig).mcpServers[snippets.serverName].env.SNAGLET_MCP_KEY
      ).toBe(MCP_KEY_PLACEHOLDER);
      expect(snippets.httpHeader).toBe(`Authorization: Bearer ${MCP_KEY_PLACEHOLDER}`);
      expect(JSON.stringify(snippets)).not.toMatch(/snaglet_mcp_/);
    }
  });
});
