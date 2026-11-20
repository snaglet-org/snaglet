import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { SnagletEnvProvenance } from '@snaglet/db/runtime/snaglet-env';
import {
  formatScriptTarget,
  parseScriptArgs,
  resolveScriptTarget,
  ScriptTargetError,
  type ScriptTargetInput,
} from '@snaglet/db/runtime/script-target';

/**
 * db-script target guard. Pure: every home lives under a throwaway
 * user home in $TMPDIR, so nothing here can touch ~/.snaglet or ~/.snaglet-dev.
 */

let userHome: string;
let prodHome: string;
let devHome: string;
let customHome: string;

beforeAll(() => {
  // realpath: macOS $TMPDIR is a symlink into /private, and the guard reports realpaths.
  userHome = realpathSync(mkdtempSync(path.join(tmpdir(), 'snaglet-script-target-')));
  prodHome = path.join(userHome, '.snaglet');
  devHome = path.join(userHome, '.snaglet-dev');
  customHome = path.join(userHome, 'lane');
  for (const dir of [prodHome, devHome, customHome]) mkdirSync(dir);
  symlinkSync(prodHome, path.join(userHome, 'prod-link'));
});

afterAll(() => rmSync(userHome, { recursive: true, force: true }));

/** Provenance where every listed key was a real shell export. */
function exported(env: NodeJS.ProcessEnv): SnagletEnvProvenance {
  return { processEnvKeys: new Set(Object.keys(env)), fileSources: new Map(), appliedDefaults: {} };
}

function input(
  env: NodeJS.ProcessEnv,
  options: Partial<ScriptTargetInput> & { resolvedHome?: string } = {}
): ScriptTargetInput {
  // Mirrors resolveDbHome(): SNAGLET_HOME, else the default (production) home.
  const resolvedHome = options.resolvedHome ?? env.SNAGLET_HOME ?? prodHome;
  return {
    script: 'migrate',
    env,
    provenance: exported(env),
    argv: [],
    productionHomes: [prodHome],
    resolvedHome,
    userHome,
    ...options,
  };
}

function refusal(fn: () => unknown): ScriptTargetError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ScriptTargetError);
    expect((error as ScriptTargetError).exitCode).toBe(2);
    expect((error as Error).message).toContain('Nothing was written');
    return error as ScriptTargetError;
  }
  throw new Error('expected a refusal');
}

describe('resolveScriptTarget', () => {
  it('R1: an empty env is refused', () => {
    const err = refusal(() => resolveScriptTarget(input({})));
    expect(err.message).toContain('no explicit target');
  });

  it('R1: NODE_ENV=production and SNAGLET_BUNDLED=1 count for nothing (no bypass)', () => {
    const env = { NODE_ENV: 'production', SNAGLET_BUNDLED: '1' };
    expect(() => resolveScriptTarget(input(env))).toThrow('no explicit target');
  });

  it('R1: a home that only the pointer file supplies is not explicit', () => {
    // resolveDbHome() followed ~/.snaglet.json to the custom home, but nothing was set.
    expect(() => resolveScriptTarget(input({}, { resolvedHome: customHome }))).toThrow(
      'no explicit target'
    );
  });

  it('R1: a mode default (SNAGLET_HOME filled in by SNAGLET_ENV) is not itself a signal', () => {
    const env = { SNAGLET_HOME: devHome };
    const provenance: SnagletEnvProvenance = {
      processEnvKeys: new Set(),
      fileSources: new Map(),
      appliedDefaults: { SNAGLET_HOME: devHome },
    };
    expect(() => resolveScriptTarget(input(env, { provenance }))).toThrow('no explicit target');
  });

  it('R5: SNAGLET_ENV=dev resolves to the dev home', () => {
    const t = resolveScriptTarget(input({ SNAGLET_ENV: 'dev', SNAGLET_HOME: devHome }));
    expect(t).toMatchObject({
      kind: 'dev',
      snagletHome: devHome,
      databaseName: 'snaglet',
      dryRun: false,
    });
    expect(t.source).toContain('SNAGLET_ENV=dev');
  });

  it('R5: SNAGLET_ENV=preview keeps its database name', () => {
    const env = {
      SNAGLET_ENV: 'preview',
      SNAGLET_HOME: devHome,
      SNAGLET_DATABASE_NAME: 'snaglet_preview',
    };
    expect(resolveScriptTarget(input(env))).toMatchObject({
      kind: 'preview',
      databaseName: 'snaglet_preview',
    });
  });

  it('R5: an explicit non-production SNAGLET_HOME is allowed', () => {
    expect(resolveScriptTarget(input({ SNAGLET_HOME: customHome }))).toMatchObject({
      kind: 'custom-home',
      snagletHome: customHome,
    });
  });

  it('env-file values count as explicit and name their file', () => {
    const env = { SNAGLET_HOME: customHome };
    const provenance: SnagletEnvProvenance = {
      processEnvKeys: new Set(),
      fileSources: new Map([['SNAGLET_HOME', '.env.local']]),
      appliedDefaults: {},
    };
    const t = resolveScriptTarget(input(env, { provenance }));
    expect(t.source).toBe('.env.local SNAGLET_HOME');
    expect(formatScriptTarget('migrate', t)[0]).toContain('source: .env.local SNAGLET_HOME');
  });

  it('R2: SNAGLET_ENV=dev with a production SNAGLET_HOME is refused', () => {
    const err = refusal(() =>
      resolveScriptTarget(input({ SNAGLET_ENV: 'dev', SNAGLET_HOME: prodHome }))
    );
    expect(err.message).toContain(
      'SNAGLET_ENV=dev but SNAGLET_HOME resolves to the production home'
    );
  });

  it('R2: --target that contradicts the resolved target is refused', () => {
    const env = { SNAGLET_ENV: 'dev', SNAGLET_HOME: devHome };
    expect(() => resolveScriptTarget(input(env, { argv: ['--target=preview'] }))).toThrow(
      '--target=preview but the resolved target is dev'
    );
    expect(() => resolveScriptTarget(input(env, { argv: ['--target=dev'] }))).not.toThrow();
  });

  it('R3: production needs --target=prod and an exported SNAGLET_ALLOW_PROD_WRITE=1', () => {
    const home = { SNAGLET_HOME: prodHome };
    expect(() => resolveScriptTarget(input(home))).toThrow('PRODUCTION');
    expect(() => resolveScriptTarget(input(home, { argv: ['--target=prod'] }))).toThrow(
      'PRODUCTION'
    );
    const allow = { ...home, SNAGLET_ALLOW_PROD_WRITE: '1' };
    expect(() => resolveScriptTarget(input(allow))).toThrow('PRODUCTION');
    expect(resolveScriptTarget(input(allow, { argv: ['--target=prod'] }))).toMatchObject({
      kind: 'prod',
    });
  });

  it('R3: --target=prod alone (no SNAGLET_HOME) is explicit but still needs the opt-in', () => {
    expect(() => resolveScriptTarget(input({}, { argv: ['--target=prod'] }))).toThrow('PRODUCTION');
    const env = { SNAGLET_ALLOW_PROD_WRITE: '1' };
    expect(resolveScriptTarget(input(env, { argv: ['--target=prod'] })).kind).toBe('prod');
  });

  it('R3: SNAGLET_ALLOW_PROD_WRITE from an env file does not unlock production', () => {
    const env = { SNAGLET_HOME: prodHome, SNAGLET_ALLOW_PROD_WRITE: '1' };
    const provenance: SnagletEnvProvenance = {
      processEnvKeys: new Set(['SNAGLET_HOME']),
      fileSources: new Map([['SNAGLET_ALLOW_PROD_WRITE', '.env.local']]),
      appliedDefaults: {},
    };
    expect(() => resolveScriptTarget(input(env, { provenance, argv: ['--target=prod'] }))).toThrow(
      'PRODUCTION'
    );
  });

  it('R3: a symlink to the production home is production', () => {
    const link = path.join(userHome, 'prod-link');
    expect(() => resolveScriptTarget(input({ SNAGLET_HOME: link }))).toThrow('PRODUCTION');
  });

  it('R3: a home the pointer file names is production too', () => {
    const env = { SNAGLET_HOME: customHome };
    expect(() =>
      resolveScriptTarget(input(env, { productionHomes: [prodHome, customHome] }))
    ).toThrow('PRODUCTION');
  });

  it('R4: an external URL needs --target=external and is printed redacted', () => {
    const env = { SNAGLET_DATABASE_URL: 'postgres://snaglet:s3cret@db.example:5432/snaglet_x' };
    expect(() => resolveScriptTarget(input(env))).toThrow('--target=external');
    expect(() => resolveScriptTarget(input(env, { argv: ['--target=dev'] }))).toThrow(
      'external database'
    );
    const t = resolveScriptTarget(input(env, { argv: ['--target', 'external'] }));
    expect(t).toMatchObject({ kind: 'external', databaseName: 'snaglet_x', snagletHome: null });
    expect(t.url).not.toContain('s3cret');
    expect(formatScriptTarget('migrate', t).join('\n')).not.toContain('s3cret');
  });

  it('R4: --target=external without a URL is refused', () => {
    expect(() =>
      resolveScriptTarget(
        input({ SNAGLET_ENV: 'dev', SNAGLET_HOME: devHome }, { argv: ['--target=external'] })
      )
    ).toThrow('SNAGLET_DATABASE_URL is not set');
  });

  it('prints a production banner and marks dry runs', () => {
    const env = { SNAGLET_ALLOW_PROD_WRITE: '1' };
    const t = resolveScriptTarget(input(env, { argv: ['--target=prod', '--dry-run'] }));
    const lines = formatScriptTarget('migrate', t);
    expect(lines[0]).toContain('!! WRITING TO PRODUCTION');
    expect(lines.join('\n')).toContain('dry run: nothing will be written');
  });
});

describe('parseScriptArgs', () => {
  it('splits guard flags from the script args', () => {
    expect(parseScriptArgs(['--all', '--target=dev', '--dry-run'])).toEqual({
      target: 'dev',
      dryRun: true,
      rest: ['--all'],
    });
    expect(parseScriptArgs(['name', '--target', 'prod'])).toMatchObject({
      target: 'prod',
      rest: ['name'],
    });
  });

  it('refuses an unknown --target value (SNAGLET_SCRIPT_TARGET does not exist)', () => {
    expect(() => parseScriptArgs(['--target=staging'])).toThrow(ScriptTargetError);
  });
});
