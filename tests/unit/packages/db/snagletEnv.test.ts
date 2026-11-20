import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  snagletEnvFileName,
  snagletModeDefaults,
  loadSnagletEnvironment,
  resolveSnagletEnvMode,
} from '@snaglet/db/runtime/snaglet-env';

/**
 * The SNAGLET_ENV mode loader is the isolation seam between dev / preview and the
 * real `~/.snaglet` install: these tests pin the precedence contract
 * (process env > .env.local > .env.<mode> > .env > mode default) and the
 * cutover safety rule that mode defaults never override explicit
 * configuration such as a live instance's SNAGLET_DATABASE_URL.
 */
describe('snaglet-env mode loader', () => {
  let envSnapshot: NodeJS.ProcessEnv;
  let tempRoot: string;
  const silent = { log: () => {}, warn: () => {} };

  beforeEach(async () => {
    envSnapshot = { ...process.env };
    tempRoot = await mkdtemp(path.join(tmpdir(), 'snaglet-env-test-'));
    delete process.env.SNAGLET_ENV;
    delete process.env.SNAGLET_HOME;
    delete process.env.SNAGLET_DATABASE_NAME;
    delete process.env.SNAGLET_DATABASE_URL;
    // Jest pins NODE_ENV=test globally; cleared here so it does not register
    // as a shadowed NODE_ENV mode default in every assertion. afterEach's
    // snapshot restore puts it back.
    delete process.env.NODE_ENV;
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
    await rm(tempRoot, { recursive: true, force: true });
  });

  const load = () => loadSnagletEnvironment(tempRoot, { stopDir: tempRoot, ...silent });

  describe('bundled server', () => {
    afterEach(() => {
      delete process.env.SNAGLET_BUNDLED;
      delete process.env.LOG_LEVEL;
    });

    it('never reads env files when SNAGLET_BUNDLED=1, even with a .env above it', async () => {
      delete process.env.LOG_LEVEL;
      await writeFile(path.join(tempRoot, '.env'), 'LOG_LEVEL=error\nSNAGLET_ENV=dev\n');
      const nested = path.join(tempRoot, 'Snaglet.app', 'Contents', 'Resources', 'server');
      process.env.SNAGLET_BUNDLED = '1';
      const result = loadSnagletEnvironment(nested, silent);
      expect(result.root).toBeNull();
      expect(result.loadedFiles).toEqual([]);
      expect(process.env.LOG_LEVEL).toBeUndefined();
      expect(result.mode).toBeNull();
    });

    it('still applies mode defaults from the process environment when bundled', () => {
      process.env.SNAGLET_BUNDLED = '1';
      process.env.SNAGLET_ENV = 'preview';
      const result = loadSnagletEnvironment(tempRoot, silent);
      expect(result.loadedFiles).toEqual([]);
      expect(result.appliedDefaults.SNAGLET_DATABASE_NAME).toBe('snaglet_preview');
      expect(process.env.SNAGLET_DATABASE_NAME).toBe('snaglet_preview');
    });
  });

  describe('resolveSnagletEnvMode', () => {
    it('returns null when SNAGLET_ENV is unset or blank', () => {
      expect(resolveSnagletEnvMode({})).toBeNull();
      expect(resolveSnagletEnvMode({ SNAGLET_ENV: '  ' })).toBeNull();
    });

    it('accepts the three modes and trims whitespace', () => {
      expect(resolveSnagletEnvMode({ SNAGLET_ENV: 'dev' })).toBe('dev');
      expect(resolveSnagletEnvMode({ SNAGLET_ENV: ' preview ' })).toBe('preview');
      expect(resolveSnagletEnvMode({ SNAGLET_ENV: 'prod' })).toBe('prod');
    });

    it('rejects unknown modes loudly instead of guessing an isolation level', () => {
      expect(() => resolveSnagletEnvMode({ SNAGLET_ENV: 'staging' })).toThrow(
        /Invalid SNAGLET_ENV/
      );
    });
  });

  describe('snagletModeDefaults', () => {
    it('maps dev and preview onto the shared ~/.snaglet-dev home', () => {
      expect(snagletModeDefaults('dev', '/Users/x')).toEqual({
        SNAGLET_HOME: path.join('/Users/x', '.snaglet-dev'),
        NODE_ENV: 'development',
      });
      expect(snagletModeDefaults('preview', '/Users/x')).toEqual({
        SNAGLET_HOME: path.join('/Users/x', '.snaglet-dev'),
        SNAGLET_DATABASE_NAME: 'snaglet_preview',
        NODE_ENV: 'production',
      });
    });

    it('gives production zero defaults and no env file — the untouched default chain', () => {
      expect(snagletModeDefaults('prod', '/Users/x')).toEqual({});
      expect(snagletEnvFileName('prod')).toBeNull();
      expect(snagletEnvFileName('dev')).toBe('.env.dev');
      expect(snagletEnvFileName('preview')).toBe('.env.preview');
    });
  });

  describe('loadSnagletEnvironment', () => {
    it('isolates dev even when no env file exists at all (fresh clone)', () => {
      process.env.SNAGLET_ENV = 'dev';
      const result = load();
      expect(result.mode).toBe('dev');
      expect(result.root).toBeNull();
      expect(process.env.SNAGLET_HOME).toBe(snagletModeDefaults('dev').SNAGLET_HOME);
      expect(result.appliedDefaults.SNAGLET_HOME).toBe(process.env.SNAGLET_HOME);
    });

    it('never touches an explicit SNAGLET_DATABASE_URL (live external-DB instances)', () => {
      process.env.SNAGLET_ENV = 'preview';
      process.env.SNAGLET_DATABASE_URL = 'postgresql://live.example/snaglet_team';
      const result = load();
      expect(process.env.SNAGLET_DATABASE_URL).toBe('postgresql://live.example/snaglet_team');
      expect(result.appliedDefaults).not.toHaveProperty('SNAGLET_DATABASE_URL');
      // Defaults for genuinely-unset keys still apply alongside.
      expect(process.env.SNAGLET_DATABASE_NAME).toBe('snaglet_preview');
    });

    it('lets the mode file beat the mode default, and process env beat the mode file', async () => {
      await writeFile(
        path.join(tempRoot, '.env.dev'),
        'SNAGLET_HOME=/from-mode-file\nEXTRA_DEV=1\n'
      );
      process.env.SNAGLET_ENV = 'dev';
      const fromFile = load();
      expect(process.env.SNAGLET_HOME).toBe('/from-mode-file');
      expect(process.env.EXTRA_DEV).toBe('1');
      expect(fromFile.appliedDefaults).not.toHaveProperty('SNAGLET_HOME');

      delete process.env.EXTRA_DEV;
      process.env.SNAGLET_HOME = '/from-process-env';
      load();
      expect(process.env.SNAGLET_HOME).toBe('/from-process-env');
    });

    it('keeps .env.local above the mode file, and the mode file above .env', async () => {
      await writeFile(path.join(tempRoot, '.env.local'), 'LAYER_A=local\n');
      await writeFile(path.join(tempRoot, '.env.preview'), 'LAYER_A=mode\nLAYER_B=mode\n');
      await writeFile(path.join(tempRoot, '.env'), 'LAYER_A=base\nLAYER_B=base\nLAYER_C=base\n');
      process.env.SNAGLET_ENV = 'preview';
      const result = load();
      expect(process.env.LAYER_A).toBe('local');
      expect(process.env.LAYER_B).toBe('mode');
      expect(process.env.LAYER_C).toBe('base');
      expect(result.loadedFiles).toEqual([
        path.join(tempRoot, '.env.local'),
        path.join(tempRoot, '.env.preview'),
        path.join(tempRoot, '.env'),
      ]);
      delete process.env.LAYER_A;
      delete process.env.LAYER_B;
      delete process.env.LAYER_C;
    });

    it('reports a shadowed default when explicit config disagrees with the mode default', async () => {
      await writeFile(path.join(tempRoot, '.env'), 'SNAGLET_DATABASE_NAME=snaglet\n');
      process.env.SNAGLET_ENV = 'preview';
      const result = load();
      expect(process.env.SNAGLET_DATABASE_NAME).toBe('snaglet');
      expect(result.shadowedDefaults).toEqual([
        expect.objectContaining({
          key: 'SNAGLET_DATABASE_NAME',
          value: 'snaglet',
          defaultValue: 'snaglet_preview',
          source: '.env',
        }),
      ]);
    });

    it('stays silent about values that merely equal the default', () => {
      process.env.SNAGLET_ENV = 'preview';
      process.env.SNAGLET_DATABASE_NAME = 'snaglet_preview';
      const warn = jest.fn();
      const result = loadSnagletEnvironment(tempRoot, { stopDir: tempRoot, log: () => {}, warn });
      expect(result.shadowedDefaults).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('never loads a .env.prod file and applies no defaults in prod', async () => {
      await writeFile(path.join(tempRoot, '.env.prod'), 'SMUGGLED=1\n');
      process.env.SNAGLET_ENV = 'prod';
      const result = load();
      expect(result.mode).toBe('prod');
      expect(process.env.SMUGGLED).toBeUndefined();
      expect(result.appliedDefaults).toEqual({});
      expect(process.env.SNAGLET_HOME).toBeUndefined();
    });

    it('does nothing mode-related when SNAGLET_ENV is unset (legacy behavior)', async () => {
      await writeFile(path.join(tempRoot, '.env'), 'PLAIN=1\n');
      const result = load();
      expect(result.mode).toBeNull();
      expect(process.env.PLAIN).toBe('1');
      expect(process.env.SNAGLET_HOME).toBeUndefined();
      expect(result.appliedDefaults).toEqual({});
      delete process.env.PLAIN;
    });
  });
});
