import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/services/ToolService/lib/loginShellPath', () => ({
  shellPath: () => '/Users/me/.nvm/versions/node/v24/bin:/usr/bin:/bin',
}));

import { describeConnectError, withLoginPath } from '@server/services/McpService/mcpTransport';
import type { McpServerConfig } from '@server/services/McpService/mcpTypes';

const stdio = { id: 'github', transport: 'stdio', command: 'npx' } as McpServerConfig;

describe('withLoginPath', () => {
  it("adds the login shell's PATH so nvm/Homebrew commands like npx are found", () => {
    expect(withLoginPath({ TOKEN: 'x' })).toEqual({
      TOKEN: 'x',
      PATH: '/Users/me/.nvm/versions/node/v24/bin:/usr/bin:/bin',
    });
  });

  it("keeps a PATH the server's own config sets", () => {
    expect(withLoginPath({ PATH: '/custom/bin' })).toEqual({ PATH: '/custom/bin' });
  });
});

describe('describeConnectError', () => {
  it('turns a missing command into a readable reason', () => {
    const err = Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' });
    expect(describeConnectError(stdio, err)).toBe(
      "Command 'npx' was not found on PATH. Set its full path in the server config."
    );
  });

  it('passes other errors through', () => {
    expect(describeConnectError(stdio, new Error('Request timed out'))).toBe('Request timed out');
  });
});
