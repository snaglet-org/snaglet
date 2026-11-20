import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, jest } from '@jest/globals';
import {
  parseWindowsBuildEnvironment,
  resolveWindowsBuildEnvironment,
} from '@snaglet/db/runtime/postgres/windows-build';

const output = [
  'Visual Studio banner',
  '__SNAGLET_PG_MSVC_ENVIRONMENT__',
  '=C:=C:\\unrelated',
  'VSCMD_ARG_TGT_ARCH=x64',
  'VSCMD_ARG_HOST_ARCH=x64',
  'VCToolsInstallDir=C:\\VS\\Tools',
  'WindowsSdkDir=C:\\SDK',
  'Path=C:\\VS\\bin;C:\\Windows',
  'INCLUDE=C:\\VS\\include',
  'LIB=C:\\VS\\lib',
  'CUSTOM=value=with=equals',
  'SNAGLET_PG_VSDEVCMD=C:\\VS\\script.bat',
].join('\r\n');

describe('Windows pgvector build environment', () => {
  it('parses one case-normalized environment without losing equals signs', () => {
    const env = parseWindowsBuildEnvironment(output);
    expect(env.PATH).toBe('C:\\VS\\bin;C:\\Windows');
    expect(env.CUSTOM).toBe('value=with=equals');
    expect(env.Path).toBeUndefined();
    expect(env.SNAGLET_PG_VSDEVCMD).toBeUndefined();
    expect(env['']).toBeUndefined();
  });

  it('rejects missing and wrong-architecture tool environments', () => {
    expect(() => parseWindowsBuildEnvironment('PATH=anything')).toThrow('did not return');
    expect(() =>
      parseWindowsBuildEnvironment(output.replace('TGT_ARCH=x64', 'TGT_ARCH=x86'))
    ).toThrow('x64 build environment');
    expect(() => parseWindowsBuildEnvironment(output.replace('WindowsSdkDir=C:\\SDK', ''))).toThrow(
      'Windows SDK'
    );
  });

  it('discovers the C++ installation and passes its path as data to a fixed command', async () => {
    const execute = jest.fn(async (command: string) =>
      command.endsWith('vswhere.exe') ? 'C:\\VS with spaces & %literal%\r\n' : output
    );
    await resolveWindowsBuildEnvironment({
      env: { 'programfiles(x86)': 'C:\\Program Files (x86)', SystemRoot: 'C:\\Windows' },
      execute,
      exists: async () => true,
    });
    expect(execute).toHaveBeenNthCalledWith(
      1,
      'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
      expect.arrayContaining(['-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64']),
      expect.objectContaining({ windowsHide: true })
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      'C:\\Windows\\System32\\cmd.exe',
      expect.arrayContaining(['/v:off', expect.stringContaining('%SNAGLET_PG_VSDEVCMD%')]),
      expect.objectContaining({
        windowsVerbatimArguments: true,
        env: expect.objectContaining({
          SNAGLET_PG_VSDEVCMD: 'C:\\VS with spaces & %literal%\\Common7\\Tools\\VsDevCmd.bat',
        }),
      })
    );
  });

  it('fails before starting a command when the installer discovery tool is absent', async () => {
    const execute = jest.fn(async () => output);
    await expect(
      resolveWindowsBuildEnvironment({ exists: async () => false, execute })
    ).rejects.toThrow('Desktop development with C++');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a missing C++ workload and an incomplete installation', async () => {
    await expect(
      resolveWindowsBuildEnvironment({ exists: async () => true, execute: async () => '' })
    ).rejects.toThrow('Windows SDK');
    await expect(
      resolveWindowsBuildEnvironment({
        exists: async (file) => !file.endsWith('cl.exe'),
        execute: async (command) => (command.endsWith('vswhere.exe') ? 'C:\\VS' : output),
      })
    ).rejects.toThrow('MSVC');
  });

  (process.platform === 'win32' ? it : it.skip)(
    'captures a real cmd environment from a script path with spaces and shell characters',
    async () => {
      const scratch = await mkdtemp(path.join(tmpdir(), 'snaglet-msvc-command-test-'));
      const installation = path.join(scratch, 'VS spaces ü 日本 & %SNAGLET_TEST_EXPANSION% !');
      const scripts = path.join(installation, 'Common7', 'Tools');
      try {
        await mkdir(scripts, { recursive: true });
        await writeFile(
          path.join(scripts, 'VsDevCmd.bat'),
          [
            '@echo off',
            'set VSCMD_ARG_TGT_ARCH=x64',
            'set VSCMD_ARG_HOST_ARCH=x64',
            'set "VCToolsInstallDir=%~dp0"',
            'set "WindowsSdkDir=%~dp0"',
            'set INCLUDE=fixture',
            'set LIB=fixture',
            'exit /b 0',
          ].join('\r\n')
        );
        const exec = promisify(execFile);
        const env = await resolveWindowsBuildEnvironment({
          env: { ...process.env, SNAGLET_TEST_EXPANSION: 'must-not-expand' },
          exists: async () => true,
          execute: async (command, args, settings) => {
            if (command.endsWith('vswhere.exe')) return installation;
            return String(
              (await exec(command, args, { ...settings, encoding: settings.encoding ?? 'utf8' }))
                .stdout
            );
          },
        });
        expect(env.VCTOOLSINSTALLDIR).toBe(scripts + path.sep);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
  );
});
