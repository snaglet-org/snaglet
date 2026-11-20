/**
 * The Claude Code CLI version Snaglet presents on OAuth requests: read from the
 * installed CLI (argv only), cached, bounded by a timeout, with a fallback
 * constant — and the Snaglet copy that replaces Anthropic's "run `claude update`".
 */
type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;
type ExecImpl = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
  callback: ExecCallback
) => void;
const mockExecFile = jest.fn();

jest.mock('child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

function execImpl(impl: ExecImpl): void {
  mockExecFile.mockImplementation(impl as (...args: unknown[]) => void);
}

function execCall(index: number): Parameters<ExecImpl> {
  return mockExecFile.mock.calls[index] as Parameters<ExecImpl>;
}
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  CLAUDE_CLI_FALLBACK_VERSION,
  claudeCodeVersionRejectionMessage,
  forgetClaudeCliVersion,
  getClaudeCliVersion,
  isClaudeCodeVersionRejection,
  parseClaudeCliVersion,
} from '@server/services/ProviderChatService/providers/claudeCliVersion';
import { buildAnthropicAuthedRequest } from '@server/services/ProviderChatService/shared';

function answerWith(stdout: string): void {
  execImpl((_cmd, _args, _opts, cb) => cb(null, stdout, ''));
}

beforeEach(() => {
  jest.useRealTimers();
  mockExecFile.mockReset();
  forgetClaudeCliVersion();
  delete process.env.SNAGLET_CLAUDE_CLI_PATH;
});

describe('parseClaudeCliVersion', () => {
  it('reads the semver from `claude --version` output', () => {
    expect(parseClaudeCliVersion('2.1.285 (Claude Code)\n')).toBe('2.1.285');
    expect(parseClaudeCliVersion('v3.0.1')).toBe('3.0.1');
    expect(parseClaudeCliVersion('command not found')).toBeNull();
  });
});

describe('getClaudeCliVersion', () => {
  it('runs the CLI with a fixed argv and a timeout, never a shell', async () => {
    answerWith('2.1.300 (Claude Code)');
    await expect(getClaudeCliVersion()).resolves.toEqual({
      version: '2.1.300',
      source: 'detected',
    });
    const [command, args, options] = execCall(0);
    expect(command).toBe('claude');
    expect(args).toEqual(['--version']);
    expect(options).toEqual(expect.objectContaining({ timeout: expect.any(Number) }));
    expect(options).not.toHaveProperty('shell');
  });

  it('honors SNAGLET_CLAUDE_CLI_PATH first', async () => {
    process.env.SNAGLET_CLAUDE_CLI_PATH = '/opt/test/bin/claude';
    answerWith('2.1.300 (Claude Code)');
    await getClaudeCliVersion();
    expect(execCall(0)[0]).toBe('/opt/test/bin/claude');
  });

  it('caches the detected version', async () => {
    answerWith('2.1.300 (Claude Code)');
    await getClaudeCliVersion();
    await getClaudeCliVersion();
    await expect(getClaudeCliVersion()).resolves.toEqual({
      version: '2.1.300',
      source: 'detected',
    });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('tries the installer locations when `claude` is not on PATH', async () => {
    execImpl((cmd, _args, _opts, cb) => {
      if (cmd === 'claude') {
        cb(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }), '', '');
        return;
      }
      cb(null, '2.1.301 (Claude Code)', '');
    });
    await expect(getClaudeCliVersion()).resolves.toEqual({
      version: '2.1.301',
      source: 'detected',
    });
    expect(mockExecFile.mock.calls.length).toBeGreaterThan(1);
  });

  it('falls back to the constant when no CLI answers', async () => {
    execImpl((_cmd, _args, _opts, cb) =>
      cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), '', '')
    );
    await expect(getClaudeCliVersion()).resolves.toEqual({
      version: CLAUDE_CLI_FALLBACK_VERSION,
      source: 'fallback',
    });
  });

  it('never makes a request wait on a CLI that hangs', async () => {
    jest.useFakeTimers();
    execImpl(() => undefined);
    const pending = getClaudeCliVersion();
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toEqual({
      version: CLAUDE_CLI_FALLBACK_VERSION,
      source: 'fallback',
    });
  });

  it('re-detects after forgetClaudeCliVersion (a version rejection)', async () => {
    answerWith('2.1.300 (Claude Code)');
    await getClaudeCliVersion();
    answerWith('2.1.400 (Claude Code)');
    forgetClaudeCliVersion();
    await expect(getClaudeCliVersion()).resolves.toEqual({
      version: '2.1.400',
      source: 'detected',
    });
  });
});

describe('buildAnthropicAuthedRequest User-Agent', () => {
  const base = { secret: 'sk-ant-oat01-test', model: 'claude-opus-5-5', system: 'sys' };

  it('presents the given CLI version on OAuth, non-Haiku requests', () => {
    const { headers } = buildAnthropicAuthedRequest({ ...base, claudeCliVersion: '2.1.300' });
    expect(headers['User-Agent']).toBe('claude-cli/2.1.300');
  });

  it('uses the fallback constant, never 2.1.80, when no version is given', () => {
    const { headers } = buildAnthropicAuthedRequest(base);
    expect(headers['User-Agent']).toBe(`claude-cli/${CLAUDE_CLI_FALLBACK_VERSION}`);
    expect(headers['User-Agent']).not.toBe('claude-cli/2.1.80');
  });

  it('sends no CLI identity with an API key', () => {
    const { headers } = buildAnthropicAuthedRequest({
      ...base,
      secret: 'sk-ant-api03-test',
      claudeCliVersion: '2.1.300',
    });
    expect(headers['User-Agent']).toBeUndefined();
  });
});

describe('version rejection copy', () => {
  const anthropicText =
    'Claude Code 2.1.80 does not support this model; run `claude update` to use it.';

  it('recognizes Anthropic’s rejection', () => {
    expect(isClaudeCodeVersionRejection(anthropicText)).toBe(true);
    expect(isClaudeCodeVersionRejection('prompt is too long')).toBe(false);
  });

  it('tells a user with a current CLI how to point Snaglet at it', () => {
    const message = claudeCodeVersionRejectionMessage('claude-opus-5-5', {
      version: CLAUDE_CLI_FALLBACK_VERSION,
      source: 'fallback',
    });
    expect(message).toContain('claude-opus-5-5');
    expect(message).toContain('SNAGLET_CLAUDE_CLI_PATH');
  });

  it('tells a user with an old CLI to update it', () => {
    const message = claudeCodeVersionRejectionMessage('claude-opus-5-5', {
      version: '2.1.80',
      source: 'detected',
    });
    expect(message).toContain('2.1.80');
    expect(message).toContain('claude update');
  });
});
