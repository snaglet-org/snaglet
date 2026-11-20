/**
 * sttEngineResolver in a packaged app built without the Apple speech helper:
 * no binary and no build script on disk. The resolver must pick local STT and
 * never run swiftc (on a Mac without the Command Line Tools, running it opens
 * the system prompt to install them) or a build.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockExistsSync = jest.fn<(path: string) => boolean>();
const mockExecFileSync = jest.fn();
const mockRelease = jest.fn<() => string>();

jest.mock('node:fs', () => ({
  ...jest.requireActual<typeof import('node:fs')>('node:fs'),
  existsSync: (path: string) => mockExistsSync(path),
}));
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof import('node:child_process')>('node:child_process'),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));
jest.mock('node:os', () => ({
  ...jest.requireActual<typeof import('node:os')>('node:os'),
  release: () => mockRelease(),
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  ensureAppleSttBinary,
  resolveSttEngineKind,
} from '@server/services/voice/sttEngineResolver';

const platform = Object.getOwnPropertyDescriptor(process, 'platform');
const forced = process.env.SNAGLET_VOICE_STT_ENGINE;
const binaryOverride = process.env.SNAGLET_APPLE_STT_BIN;

describe('a packaged app without the Apple speech helper', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.SNAGLET_VOICE_STT_ENGINE;
    delete process.env.SNAGLET_APPLE_STT_BIN;
    mockExistsSync.mockReset().mockReturnValue(false);
    mockExecFileSync.mockReset();
    mockRelease.mockReset().mockReturnValue('25.6.0');
  });

  afterAll(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
    if (forced === undefined) delete process.env.SNAGLET_VOICE_STT_ENGINE;
    else process.env.SNAGLET_VOICE_STT_ENGINE = forced;
    if (binaryOverride === undefined) delete process.env.SNAGLET_APPLE_STT_BIN;
    else process.env.SNAGLET_APPLE_STT_BIN = binaryOverride;
  });

  it('uses local STT on macOS 26 and never runs swiftc or a build', () => {
    expect(resolveSttEngineKind()).toBe('local');
    expect(ensureAppleSttBinary()).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('uses local STT on macOS 14 without looking for the helper at all', () => {
    mockRelease.mockReturnValue('23.6.0');
    expect(resolveSttEngineKind()).toBe('local');
    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('uses the Apple sidecar on macOS 26 when the binary was bundled', () => {
    mockExistsSync.mockImplementation((path) => path.endsWith('/bin/snaglet-apple-stt'));
    expect(resolveSttEngineKind()).toBe('apple');
    expect(ensureAppleSttBinary()).toMatch(/\/bin\/snaglet-apple-stt$/);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
