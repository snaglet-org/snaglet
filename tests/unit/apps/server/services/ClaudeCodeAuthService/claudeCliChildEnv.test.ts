/**
 * Snaglet runs the Claude Code CLI itself: `claude --version` (on first use, hourly, and after a
 * version rejection) and `claude auth login`. The candidates include ~/.claude/local/claude
 * and ~/.local/bin/claude, files an agent can replace with its shell, so neither run may get
 * the server's own environment (session and panel tokens, the credential encryption key,
 * provider keys). What the CLI needs (HOME, USER, PATH, locale, proxy and CA settings) still
 * reaches it.
 */
import { EventEmitter } from 'events';

interface Call {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
}
const calls: Call[] = [];

jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  const optionsOf = (args: unknown[]) =>
    args.find(
      (arg): arg is { env?: NodeJS.ProcessEnv } =>
        typeof arg === 'object' && arg !== null && !Array.isArray(arg)
    );
  return {
    ...actual,
    execFile: (command: string, args: readonly string[], ...rest: unknown[]) => {
      calls.push({ command, args, env: optionsOf(rest)?.env });
      const callback = rest[rest.length - 1] as (err: Error | null, out: string) => void;
      callback(null, '2.1.300 (Claude Code)\n');
    },
    spawn: (command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: options?.env });
      return Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        exitCode: null,
        signalCode: null,
        kill: () => true,
      });
    },
  };
});
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ClaudeCodeLoginService } from '@server/services/ClaudeCodeAuthService/loginSession';
import {
  forgetClaudeCliVersion,
  getClaudeCliVersion,
} from '@server/services/ProviderChatService/providers/claudeCliVersion';

const SECRETS: Record<string, string> = {
  SNAGLET_AUTH_TOKEN: 'test-auth-token-aaaaaaaa',
  SNAGLET_PANEL_TOKEN: 'test-panel-token-aaaaaaaa',
  SNAGLET_SHUTDOWN_TOKEN: 'test-shutdown-token-aaaaaaaa',
  SNAGLET_EXPORT_GRANT_KEY: 'test-export-key-aaaaaaaa',
  CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-key-aaaaaaaa',
  ANTHROPIC_API_KEY: 'test-provider-key-aaaaaaaa',
};
const SETTINGS: Record<string, string> = {
  HTTPS_PROXY: 'http://proxy.example.com:3128',
  NODE_EXTRA_CA_CERTS: '/tmp/test-ca.pem',
  USER: 'test-user',
  LANG: 'en_US.UTF-8',
};
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [key, value] of Object.entries({ ...SECRETS, ...SETTINGS })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
beforeEach(() => {
  calls.length = 0;
});

function expectCliEnv(env: NodeJS.ProcessEnv | undefined): void {
  expect(env).toBeDefined();
  for (const key of Object.keys(SECRETS)) expect(env?.[key]).toBeUndefined();
  for (const [key, value] of Object.entries(SETTINGS)) expect(env?.[key]).toBe(value);
  expect(env?.HOME).toBe(process.env.HOME);
  expect(env?.PATH).toBeTruthy();
}

describe('Claude Code CLI children', () => {
  it("`claude --version` runs without the server's secrets", async () => {
    forgetClaudeCliVersion();
    await expect(getClaudeCliVersion()).resolves.toEqual({
      version: '2.1.300',
      source: 'detected',
    });
    const call = calls.find((c) => c.args.includes('--version'));
    expectCliEnv(call?.env);
  });

  it("`claude auth login` runs without the server's secrets", async () => {
    const service = new ClaudeCodeLoginService({
      preflight: async () => null,
      complete: async () => ({ ok: true, message: 'connected' }),
      readAuth: async () => null,
    });
    service.start();
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
    service.shutdown();
    const call = calls.find((c) => c.args.join(' ') === 'auth login');
    expectCliEnv(call?.env);
  });
});
