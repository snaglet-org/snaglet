/**
 * Code search and find_files run ripgrep in a folder the agent picks. ripgrep reads extra
 * flags from the file RIPGREP_CONFIG_PATH names, and an agent can edit that file to add
 * `--pre=<program>` (run on every searched file) or `--search-zip`. So ripgrep runs with
 * `--no-config` and never gets the server's own environment (session and panel tokens,
 * provider keys). A fake `rg` records the argv and environment it was started with.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import codeSearch from '@server/services/ToolService/handlers/search/codeSearch';
import { listFilesByGlob } from '@server/services/ToolService/lib/listFilesByGlob';

const SECRETS: Record<string, string> = {
  SNAGLET_AUTH_TOKEN: 'test-auth-token-aaaaaaaa',
  SNAGLET_PANEL_TOKEN: 'test-panel-token-aaaaaaaa',
  CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-key-aaaaaaaa',
  ANTHROPIC_API_KEY: 'test-provider-key-aaaaaaaa',
};
const describePosix = process.platform === 'win32' ? describe.skip : describe;

let root: string;
let fakeRg: string;
let envDump: string;
let argsDump: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'snaglet-rg-env-'));
  envDump = path.join(root, 'rg-env.txt');
  argsDump = path.join(root, 'rg-args.txt');
  fakeRg = path.join(root, 'rg');
  await writeFile(
    fakeRg,
    `#!/bin/sh\nenv > '${envDump}'\nprintf '%s\\n' "$@" > '${argsDump}'\necho '${root}/notes.ts'\n`
  );
  await chmod(fakeRg, 0o755);
  const config = path.join(root, 'ripgreprc');
  await writeFile(config, `--pre=${path.join(root, 'planted.sh')}\n`);
  for (const [key, value] of Object.entries({
    ...SECRETS,
    RIPGREP_CONFIG_PATH: config,
    SNAGLET_RIPGREP_PATH: fakeRg,
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

async function lastRun(): Promise<{ env: string; args: string[] }> {
  const env = await readFile(envDump, 'utf8');
  const args = (await readFile(argsDump, 'utf8')).split('\n').filter(Boolean);
  await rm(envDump, { force: true });
  await rm(argsDump, { force: true });
  return { env, args };
}

function expectScrubbed({ env, args }: { env: string; args: string[] }): void {
  for (const [key, value] of Object.entries(SECRETS)) {
    expect(env).not.toContain(value);
    expect(env).not.toMatch(new RegExp(`^${key}=`, 'm'));
  }
  expect(env).not.toMatch(/^RIPGREP_CONFIG_PATH=/m);
  expect(env).toMatch(/^HOME=/m);
  expect(args[0]).toBe('--no-config');
}

describePosix('ripgrep children', () => {
  it('code search by name ignores the ripgrep config and the server env', async () => {
    await codeSearch({ query: 'notes', path: root, mode: 'name' }, {});
    expectScrubbed(await lastRun());
  });

  it('code search by content does too', async () => {
    await codeSearch({ query: 'hello', path: root, mode: 'content' }, {});
    expectScrubbed(await lastRun());
  });

  it('find_files does too', async () => {
    await listFilesByGlob(root, '*.ts', { executable: fakeRg });
    expectScrubbed(await lastRun());
  });
});
