/**
 * A desktop app opened from Finder has a short PATH, so a CLI the official installer put in
 * ~/.local/bin is not on it. Sign-in must find it the same way the version check does.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';

let mockPath = '';
let mockHome = '';
jest.mock('os', () => ({
  ...jest.requireActual<typeof import('os')>('os'),
  homedir: () => mockHome,
}));
jest.mock('@server/services/ToolService/lib/buildSafeEnv', () => ({
  buildCommandEnv: () => ({ PATH: mockPath, HOME: mockHome }),
}));
const spawned: string[] = [];
jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (command: string) => {
      spawned.push(command);
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

import {
  claudeCliCandidates,
  resolveClaudeCliCommand,
} from '@server/services/ProviderChatService/providers/claudeCliLocation';
import {
  ClaudeCodeLoginService,
  LOGIN_MESSAGES,
} from '@server/services/ClaudeCodeAuthService/loginSession';

let root: string;
let home: string;
let pathDir: string;
const savedPin = process.env.SNAGLET_CLAUDE_CLI_PATH;

function executable(file: string): string {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-cli-location-'));
  home = join(root, 'home');
  pathDir = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(pathDir, { recursive: true });
  mockHome = home;
  delete process.env.SNAGLET_CLAUDE_CLI_PATH;
  mockPath = pathDir;
  spawned.length = 0;
});
afterEach(() => {
  if (savedPin === undefined) delete process.env.SNAGLET_CLAUDE_CLI_PATH;
  else process.env.SNAGLET_CLAUDE_CLI_PATH = savedPin;
  rmSync(root, { recursive: true, force: true });
});

describe('resolveClaudeCliCommand', () => {
  it('finds the native installer location when `claude` is not on PATH', () => {
    const installed = executable(join(home, '.local', 'bin', 'claude'));
    expect(resolveClaudeCliCommand()).toBe(installed);
  });

  it('prefers the CLI on PATH', () => {
    executable(join(home, '.local', 'bin', 'claude'));
    const onPath = executable(join(pathDir, 'claude'));
    expect(resolveClaudeCliCommand()).toBe(onPath);
  });

  it('honors SNAGLET_CLAUDE_CLI_PATH first', () => {
    executable(join(pathDir, 'claude'));
    const pinned = executable(join(root, 'elsewhere', 'claude'));
    process.env.SNAGLET_CLAUDE_CLI_PATH = pinned;
    expect(resolveClaudeCliCommand()).toBe(pinned);
    expect(claudeCliCandidates()[0]).toBe(pinned);
  });

  it('skips a file that is not executable', () => {
    const file = join(home, '.local', 'bin', 'claude');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '');
    chmodSync(file, 0o644);
    expect(resolveClaudeCliCommand()).toBe('claude');
  });

  it('returns the bare name when nothing is installed, so the spawn reports a missing CLI', () => {
    expect(resolveClaudeCliCommand()).toBe('claude');
  });
});

describe('claude auth login', () => {
  it('starts the CLI from the installer location when it is not on PATH', async () => {
    const installed = executable(join(home, '.local', 'bin', 'claude'));
    const service = new ClaudeCodeLoginService({
      preflight: async () => null,
      complete: async () => ({ ok: true, message: 'connected' }),
      readAuth: async () => null,
    });
    service.start();
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
    service.shutdown();
    expect(spawned).toEqual([installed]);
  });

  it('names the native installer and the path setting when the CLI is missing', () => {
    expect(LOGIN_MESSAGES.missingCli).toContain('claude.ai/install.sh');
    expect(LOGIN_MESSAGES.missingCli).toContain('SNAGLET_CLAUDE_CLI_PATH');
  });
});
