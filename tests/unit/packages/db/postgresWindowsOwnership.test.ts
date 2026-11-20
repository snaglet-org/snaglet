import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { restrictPostgresPath } from '@snaglet/db/runtime/postgres/filesystem';
import { withWindowsPostgresLease } from '@snaglet/db/runtime/postgres/lease';

const exec = promisify(execFile);
// These exercise actual Windows ACL and child-process APIs, including cold shell startup.
jest.setTimeout(30_000);

(process.platform === 'win32' ? describe : describe.skip)(
  'native Windows PostgreSQL ownership',
  () => {
    let scratch: string;
    beforeEach(async () => {
      scratch = await mkdtemp(path.join(tmpdir(), 'snaglet-windows-db-ownership-'));
    });
    afterEach(async () => {
      await rm(scratch, { recursive: true, force: true });
    });

    it('replaces explicit broad credential ACL grants with a protected owner-only DACL', async () => {
      const target = path.join(scratch, 'password with spaces');
      await writeFile(target, 'synthetic credential');
      await exec('icacls.exe', [target, '/grant', '*S-1-1-0:F'], { windowsHide: true });
      await restrictPostgresPath(target);
      await restrictPostgresPath(target);
      const script =
        '$acl = Get-Acl -LiteralPath $env:SNAGLET_ACL_TEST_PATH; $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)';
      const { stdout } = await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        {
          windowsHide: true,
          env: { ...process.env, SNAGLET_ACL_TEST_PATH: target },
        }
      );
      expect(stdout.trim()).toMatch(/^D:P(?:AI)?\(A;;FA;;;S-1-[\d-]+\)$/);
      expect(await readFile(target, 'utf8')).toBe('synthetic credential');
    });

    it('automatically releases exclusion after the owning child process is terminated', async () => {
      const dataDir = path.join(scratch, 'postgres');
      const moduleUrl = pathToFileURL(path.resolve('packages/db/runtime/postgres/lease.ts')).href;
      const child = spawn(
        process.execPath,
        [
          '--import=tsx',
          '--input-type=module',
          '-e',
          `
      const { withWindowsPostgresLease } = await import(${JSON.stringify(moduleUrl)});
      await withWindowsPostgresLease(${JSON.stringify(dataDir)}, async () => {
        process.send('ready');
        await new Promise(() => {});
      });
    `,
        ],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true }
      );
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('message', () => resolve());
          child.once('exit', (code) =>
            reject(new Error(`lease child exited before readiness: ${code}`))
          );
        });
        await expect(withWindowsPostgresLease(dataDir, async () => true, 200)).rejects.toThrow(
          /Timed out/
        );
        child.kill('SIGKILL');
        await exited;
        await expect(
          withWindowsPostgresLease(dataDir, async () => 'recovered', 1_000)
        ).resolves.toBe('recovered');
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
    });
  }
);
