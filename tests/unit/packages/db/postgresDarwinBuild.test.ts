import { type ExecFileOptions } from 'node:child_process';
import { access } from 'node:fs/promises';
import { describe, expect, it, jest } from '@jest/globals';
import { resolveDarwinBuildEnvironment } from '@snaglet/db/runtime/postgres/darwin-build';

const selected = '/Developer/SDKs/MacOSX27.0.sdk';
const compatible = '/Developer/SDKs/MacOSX.sdk';

describe('macOS PostgreSQL build environment', () => {
  it('falls back from a mismatched discovered SDK and cleans the compiler probe', async () => {
    let source = '';
    const inherited = { PATH: '/usr/bin', CFLAGS: '-O2' };
    const execute = jest.fn(async (command: string, args: string[], settings: ExecFileOptions) => {
      if (command === '/usr/bin/xcrun') return selected;
      if (command === '/usr/bin/xcode-select') return '/Developer';
      if (command === '/bin/sh') {
        source = args[3];
        if (settings.env?.SDKROOT === selected) throw new Error('ld: unknown architecture');
      }
      return '';
    });
    const env = await resolveDarwinBuildEnvironment({ env: inherited, execute });
    expect(env).toEqual({ ...inherited, SDKROOT: compatible, MACOSX_DEPLOYMENT_TARGET: '14.0' });
    expect(inherited).not.toHaveProperty('SDKROOT');
    expect(execute).toHaveBeenCalledWith(
      '/bin/sh',
      expect.any(Array),
      expect.objectContaining({ env })
    );
    await expect(access(source)).rejects.toThrow();
  });

  it('keeps an explicit SDK and does not probe alternative installations', async () => {
    const execute = jest.fn(async () => '');
    const env = await resolveDarwinBuildEnvironment({ env: { SDKROOT: '/custom/sdk' }, execute });
    expect(env.SDKROOT).toBe('/custom/sdk');
    expect(execute).toHaveBeenCalledTimes(2); // Compile/link, then execute.
  });

  it('reports a broken explicit SDK without silently replacing it', async () => {
    const execute = jest.fn(async () => {
      throw new Error('linker failed');
    });
    await expect(
      resolveDarwinBuildEnvironment({ env: { SDKROOT: '/custom/sdk' }, execute })
    ).rejects.toThrow(/No working macOS compiler\/SDK pair[\s\S]*linker failed/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('explains how to install missing developer tools before building', async () => {
    await expect(
      resolveDarwinBuildEnvironment({
        env: {},
        execute: async () => {
          throw new Error('no developer directory');
        },
      })
    ).rejects.toThrow('xcode-select --install');
  });

  it('rejects binaries that link but cannot execute', async () => {
    let source = '';
    await expect(
      resolveDarwinBuildEnvironment({
        env: { SDKROOT: '/custom/sdk' },
        execute: async (command, args) => {
          if (command === '/bin/sh') {
            source = args[3];
            return '';
          }
          throw new Error('Bad CPU type in executable');
        },
      })
    ).rejects.toThrow('Bad CPU type');
    await expect(access(source)).rejects.toThrow();
  });
});
