import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolveDbHome } from '@snaglet/db/runtime/snaglet-home';

/**
 * Tilde handling in the DB-side Snaglet home resolver. `.env` values are never
 * shell-expanded (dotenv delivers `SNAGLET_HOME=~/.snaglet` literally), and resolving
 * that against the process cwd would create homes like `<repo>/~/.snaglet` with
 * their own PostgreSQL clusters.
 */

const SAVED_KEYS = ['SNAGLET_HOME', 'SNAGLET_HOME_POINTER_FILE'] as const;

describe('resolveDbHome — tilde expansion and relative rejection', () => {
  let saved: Partial<Record<(typeof SAVED_KEYS)[number], string | undefined>>;
  let scratch: string;

  beforeEach(() => {
    saved = Object.fromEntries(SAVED_KEYS.map((key) => [key, process.env[key]]));
    scratch = mkdtempSync(path.join(tmpdir(), 'snaglet-home-resolve-'));
  });

  afterEach(() => {
    for (const key of SAVED_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  it('expands SNAGLET_HOME=~/.snaglet to <homedir>/.snaglet', () => {
    process.env.SNAGLET_HOME = '~/.snaglet';
    expect(resolveDbHome()).toBe(path.join(homedir(), '.snaglet'));
  });

  it('expands a bare SNAGLET_HOME=~ to the home directory', () => {
    process.env.SNAGLET_HOME = '~';
    expect(resolveDbHome()).toBe(homedir());
  });

  it('passes an absolute SNAGLET_HOME through unchanged', () => {
    process.env.SNAGLET_HOME = scratch;
    expect(resolveDbHome()).toBe(scratch);
  });

  it('survives an .env value with surrounding spaces (trimmed upstream)', () => {
    // dotenv strips the inline comment but delivers the literal `~/.snaglet`.
    process.env.SNAGLET_HOME = ' ~/.snaglet ';
    expect(resolveDbHome()).toBe(path.join(homedir(), '.snaglet'));
  });

  it('rejects a bare relative SNAGLET_HOME instead of resolving against cwd', () => {
    process.env.SNAGLET_HOME = 'some/relative/home';
    expect(() => resolveDbHome()).toThrow(/SNAGLET_HOME must be an absolute path/);
  });

  it('expands a tilde homePath read from the pointer file', () => {
    delete process.env.SNAGLET_HOME;
    const pointerFile = path.join(scratch, 'pointer.json');
    writeFileSync(pointerFile, JSON.stringify({ homePath: '~/snaglet-tilde-home' }));
    process.env.SNAGLET_HOME_POINTER_FILE = pointerFile;
    expect(resolveDbHome()).toBe(path.join(homedir(), 'snaglet-tilde-home'));
  });

  it('passes an absolute pointer homePath through unchanged', () => {
    delete process.env.SNAGLET_HOME;
    const pointerFile = path.join(scratch, 'pointer.json');
    const home = path.join(scratch, 'configured-home');
    writeFileSync(pointerFile, JSON.stringify({ homePath: home }));
    process.env.SNAGLET_HOME_POINTER_FILE = pointerFile;
    expect(resolveDbHome()).toBe(home);
  });

  it('rejects a relative pointer homePath, naming the pointer file', () => {
    delete process.env.SNAGLET_HOME;
    const pointerFile = path.join(scratch, 'pointer.json');
    writeFileSync(pointerFile, JSON.stringify({ homePath: 'relative-home' }));
    process.env.SNAGLET_HOME_POINTER_FILE = pointerFile;
    expect(() => resolveDbHome()).toThrow(/homePath in .*pointer\.json must be an absolute path/);
  });

  it('rejects a relative SNAGLET_HOME_POINTER_FILE instead of probing cwd', () => {
    delete process.env.SNAGLET_HOME;
    process.env.SNAGLET_HOME_POINTER_FILE = 'relative/pointer.json';
    expect(() => resolveDbHome()).toThrow(/SNAGLET_HOME_POINTER_FILE must be an absolute path/);
  });
});
