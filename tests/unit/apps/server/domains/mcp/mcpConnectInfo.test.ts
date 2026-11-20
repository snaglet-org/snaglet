/**
 * mcpConnectInfo: the home, production / dev profile, port
 * and the `snaglet` command that runs the CLI for this home, worked out on the
 * server from real files in a temp "user home": the Snaglet launcher (which bakes
 * its app's SNAGLET_HOME and overrides any the client passes), the Snaglet CLI script
 * itself, an unrelated `snaglet` binary, and a dev checkout's CLI.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/config', () => ({ serverConfig: { port: 4001 } }));

import { mcpConnectInfo } from '@server/domains/mcp/mcpConnectInfo';

const MARKER = '# Snaglet CLI launcher — managed by Snaglet Desktop';

let root: string;
let userHome: string;
let prodHome: string;
let devHome: string;
let pathBin: string;
let repoCli: string;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A launcher as cli_install.rs writes it, baking `home`. */
async function launcher(file: string, home: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `#!/bin/sh\n${MARKER}\nexport SNAGLET_HOME=${shellQuote(home)}\nexec '/node' '/cli/snaglet.mjs' "$@"\n`
  );
  await chmod(file, 0o755);
  return file;
}

async function script(file: string, body: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  await chmod(file, 0o755);
  return file;
}

const installPath = () => path.join(userHome, '.local', 'bin', 'snaglet');

const info = (overrides: Parameters<typeof mcpConnectInfo>[0] = {}) =>
  mcpConnectInfo({
    snagletHome: prodHome,
    userHome,
    pathValue: pathBin,
    platform: 'darwin',
    bundled: true,
    envMode: null,
    port: 51234,
    bindHost: '',
    localAppData: undefined,
    repoCli,
    ...overrides,
  });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'snaglet-connect-info-'));
  userHome = path.join(root, 'Test User');
  prodHome = path.join(userHome, '.snaglet');
  devHome = path.join(userHome, '.snaglet-dev');
  pathBin = path.join(root, 'bin');
  repoCli = path.join(root, 'repo', 'packages', 'snaglet-cli', 'bin', 'snaglet.mjs');
  for (const dir of [prodHome, devHome, pathBin]) await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('mcpConnectInfo', () => {
  it('the installed app with its launcher on PATH: production, default home, `snaglet`', async () => {
    await launcher(path.join(pathBin, 'snaglet'), prodHome);
    expect(info()).toEqual({
      snagletHome: prodHome,
      isDefaultHome: true,
      profile: 'production',
      cliPath: path.join(pathBin, 'snaglet'),
      cliOnPath: true,
      port: 51234,
      mcpUrl: 'http://127.0.0.1:51234/mcp',
    });
  });

  it('a launcher installed but not on PATH gives its absolute path', async () => {
    await launcher(installPath(), prodHome);
    expect(info()).toMatchObject({ cliOnPath: false, cliPath: installPath() });
  });

  it('a dev server: another home’s launcher on PATH is not used; the checkout’s CLI is', async () => {
    await launcher(path.join(pathBin, 'snaglet'), prodHome);
    await launcher(installPath(), prodHome);
    await script(
      repoCli,
      '#!/usr/bin/env node\n// snaglet mcp bridges a stdio MCP client (Claude Code, ...)\n'
    );
    expect(info({ snagletHome: devHome, bundled: false, envMode: 'dev', port: 4001 })).toEqual({
      snagletHome: devHome,
      isDefaultHome: false,
      profile: 'dev',
      cliPath: repoCli,
      cliOnPath: false,
      port: 4001,
      mcpUrl: 'http://127.0.0.1:4001/mcp',
    });
  });

  it('the Snaglet CLI script itself on PATH honors SNAGLET_HOME, so it serves any home', async () => {
    await script(
      path.join(pathBin, 'snaglet'),
      '#!/usr/bin/env node\n/* snaglet — Snaglet command line. snaglet mcp bridges a stdio MCP client */\n'
    );
    expect(info({ snagletHome: devHome, bundled: false })).toMatchObject({
      cliOnPath: true,
      cliPath: path.join(pathBin, 'snaglet'),
    });
  });

  it('an unrelated `snaglet` on PATH is never offered', async () => {
    await script(path.join(pathBin, 'snaglet'), '#!/bin/sh\necho "some other snaglet tool"\n');
    expect(info()).toMatchObject({ cliOnPath: false, cliPath: null });
  });

  it('the packaged app never falls back to a checkout, and says when there is no CLI', async () => {
    await script(repoCli, '#!/usr/bin/env node\n// snaglet mcp bridges a stdio MCP client\n');
    expect(info()).toMatchObject({ cliOnPath: false, cliPath: null });
  });

  it('reads a launcher home with spaces and quotes', async () => {
    const odd = path.join(root, "Test User's Mac", 'Snaglet home');
    await mkdir(odd, { recursive: true });
    await launcher(path.join(pathBin, 'snaglet'), odd);
    expect(info({ snagletHome: odd })).toMatchObject({
      snagletHome: odd,
      isDefaultHome: false,
      cliOnPath: true,
    });
  });

  it('a non-executable `snaglet` is skipped', async () => {
    await launcher(path.join(pathBin, 'snaglet'), prodHome);
    await chmod(path.join(pathBin, 'snaglet'), 0o644);
    expect(info()).toMatchObject({ cliOnPath: false, cliPath: null });
  });

  it.each([
    [{ bundled: true, envMode: null }, 'production'],
    [{ bundled: true, envMode: 'preview' }, 'dev'],
    [{ bundled: false, envMode: null }, 'dev'],
    [{ bundled: false, envMode: 'dev' }, 'dev'],
  ])('%j is %s', (overrides, profile) => {
    expect(info(overrides).profile).toBe(profile);
  });

  it.each([
    ['0.0.0.0', 'http://127.0.0.1:51234/mcp'],
    ['127.0.0.1', 'http://127.0.0.1:51234/mcp'],
    ['::1', 'http://[::1]:51234/mcp'],
    ['192.168.1.20', 'http://192.168.1.20:51234/mcp'],
  ])('bind host %s → %s', (bindHost, mcpUrl) => {
    expect(info({ bindHost }).mcpUrl).toBe(mcpUrl);
  });

  it('a Windows launcher (snaglet.cmd, set "SNAGLET_HOME=…") is read too', async () => {
    const cmd = path.join(pathBin, 'snaglet.cmd');
    await writeFile(
      cmd,
      `@echo off\r\nrem ${MARKER}\r\nset "SNAGLET_HOME=${prodHome.replace(/%/g, '%%')}"\r\n"node" "cli" %*\r\n`
    );
    expect(info({ platform: 'win32', pathValue: pathBin })).toMatchObject({
      cliOnPath: true,
      cliPath: cmd,
    });
  });
});
