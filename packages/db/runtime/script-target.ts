/**
 * Target guard for db scripts that write. From a source checkout a write
 * script (e.g. `pnpm --filter @snaglet/db migrate`) must name its target; it never
 * silently falls back to the production `~/.snaglet`:
 *
 *   R1  No explicit target (SNAGLET_ENV, SNAGLET_HOME, SNAGLET_DATABASE_URL or --target)
 *       -> refuse. The pointer file (`~/.snaglet.json`) and mode defaults never
 *       count; NODE_ENV never counts.
 *   R2  Signals disagree (SNAGLET_ENV=dev but the home is production, --target
 *       naming something else than what resolved) -> refuse, naming both.
 *   R3  The resolved home is production (realpath; symlinks included) ->
 *       allowed only with `--target=prod` and `SNAGLET_ALLOW_PROD_WRITE=1` exported
 *       in the real shell (an env file can't supply it).
 *   R4  SNAGLET_DATABASE_URL (external) -> allowed only with `--target=external`.
 *   R5  Otherwise (dev, preview, an explicit non-production SNAGLET_HOME) -> allowed.
 *
 * Env files count as explicit, and the printed target names the file
 * (`source: .env.local SNAGLET_HOME`). The guard runs only from CLI entry points
 * (migrations.ts / db.ts main blocks, db:scratch, sync-internal-tool); the
 * packaged server boots through `initializeDatabase()` and never reaches one,
 * so `SNAGLET_BUNDLED` is ignored here. `resolveScriptTarget` is pure, so the rules
 * are unit-tested without touching a real home.
 */

import { realpathSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { getErrorMessage } from '@snaglet/shared/utils';
import { resolveConfiguredPath } from '@snaglet/shared/utils/paths';
import {
  snagletEnvProvenance,
  resolveSnagletEnvMode,
  type SnagletEnvProvenance,
} from './snaglet-env';
import { productionDbHomes, resolveDbHome } from './snaglet-home';

export type ScriptName = 'migrate' | 'init' | 'scratch' | 'sync-tool';
type ScriptTargetKind = 'dev' | 'preview' | 'prod' | 'custom-home' | 'external';
export type TargetFlag = 'dev' | 'preview' | 'prod' | 'external';
const TARGET_FLAGS: readonly TargetFlag[] = ['dev', 'preview', 'prod', 'external'];

export interface ScriptTarget {
  kind: ScriptTargetKind;
  /** Resolved absolute home (managed), or null for an external URL. */
  snagletHome: string | null;
  /** Database name inside the managed cluster (or from the URL). */
  databaseName: string;
  /** External URL with the password redacted, or null. */
  url: string | null;
  /** The signals that chose it, e.g. `SNAGLET_ENV=dev (env)` or `.env.local SNAGLET_HOME`. */
  source: string;
  /** `--dry-run` was passed. */
  dryRun: boolean;
}

/** A refusal. Exit code 2; nothing has connected or written yet. */
export class ScriptTargetError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'ScriptTargetError';
  }
}

export interface ScriptTargetInput {
  script: ScriptName;
  /** process.env after env files and mode defaults were applied. */
  env: NodeJS.ProcessEnv;
  /** Where each key came from; null means "everything in env is a real export". */
  provenance: SnagletEnvProvenance | null;
  /** CLI args (process.argv.slice(2)). */
  argv: readonly string[];
  /** Homes that count as production (see productionDbHomes). */
  productionHomes: readonly string[];
  /** The resolved managed home (resolveDbHome() under `env`). */
  resolvedHome: string;
  /** The user's home directory (for `~/.snaglet-dev`). */
  userHome: string;
  /** realpath that tolerates a missing path. */
  realpath?: (p: string) => string;
}

function defaultRealpath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/** `--target=<x>` / `--target <x>` and `--dry-run`; everything else passes through. */
export function parseScriptArgs(argv: readonly string[]): {
  target: TargetFlag | null;
  dryRun: boolean;
  rest: string[];
} {
  let target: string | null = null;
  let dryRun = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
    } else if (arg === '--target') {
      target = argv[i + 1] ?? '';
      i++;
    } else {
      rest.push(arg);
    }
  }
  if (target !== null && !(TARGET_FLAGS as readonly string[]).includes(target)) {
    throw new ScriptTargetError(
      `[db] Refusing: unknown --target=${JSON.stringify(target)}. ` +
        `Expected one of ${TARGET_FLAGS.join(' | ')}. Nothing was written.`
    );
  }
  return { target: target as TargetFlag | null, dryRun, rest };
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<unparseable SNAGLET_DATABASE_URL>';
  }
}

function urlDatabaseName(raw: string): string {
  try {
    return decodeURIComponent(new URL(raw).pathname.replace(/^\//, '')) || '(default)';
  } catch {
    return '(unknown)';
  }
}

/** Resolve and check the target. Throws ScriptTargetError on any refusal. */
export function resolveScriptTarget(input: ScriptTargetInput): ScriptTarget {
  const { env, provenance, script } = input;
  const realpath = input.realpath ?? defaultRealpath;
  const { target, dryRun } = parseScriptArgs(input.argv);

  // Where an explicitly configured key came from; null when it isn't explicit
  // (unset, or only a mode default filled it in).
  const explicitSource = (key: string): string | null => {
    if (!isSet(env[key])) return null;
    if (!provenance || provenance.processEnvKeys.has(key)) return `${key} (env)`;
    const file = provenance.fileSources.get(key);
    if (file) return `${file} ${key}`;
    return null; // mode default or set after load: not explicit
  };

  const modeSource = explicitSource('SNAGLET_ENV');
  const homeSource = explicitSource('SNAGLET_HOME');
  const urlSource = explicitSource('SNAGLET_DATABASE_URL');
  const mode = modeSource ? resolveSnagletEnvMode(env) : null;
  const sources = [
    modeSource && mode ? `SNAGLET_ENV=${mode} via ${modeSource}` : null,
    homeSource,
    urlSource,
  ].filter((s): s is string => s !== null);
  if (target) sources.push(`--target=${target}`);

  // R1: something deliberate has to pick the target.
  if (sources.length === 0) {
    throw new ScriptTargetError(
      `[db] Refusing to run ${script}: no explicit target. Set SNAGLET_ENV=dev (dev cluster ~/.snaglet-dev), ` +
        'or pass --target=<dev|preview|prod|external>. The ~/.snaglet.json pointer and NODE_ENV do not ' +
        'count. Nothing was written.'
    );
  }
  const source = sources.join(', ');

  // External database.
  const rawUrl = env.SNAGLET_DATABASE_URL?.trim();
  if (rawUrl) {
    if (!urlSource) {
      throw new ScriptTargetError(
        `[db] Refusing to run ${script}: SNAGLET_DATABASE_URL was not set explicitly. Nothing was written.`
      );
    }
    if (target !== 'external') {
      throw new ScriptTargetError(
        target
          ? `[db] Refusing: --target=${target} but SNAGLET_DATABASE_URL selects an external database ` +
              `(${redactUrl(rawUrl)}). Nothing was written.`
          : `[db] Refusing to write to an external database (${redactUrl(rawUrl)}) without ` +
              '--target=external. Nothing was written.'
      );
    }
    return {
      kind: 'external',
      snagletHome: null,
      databaseName: urlDatabaseName(rawUrl),
      url: redactUrl(rawUrl),
      source,
      dryRun,
    };
  }
  if (target === 'external') {
    throw new ScriptTargetError(
      '[db] Refusing: --target=external but SNAGLET_DATABASE_URL is not set. Nothing was written.'
    );
  }

  // Managed home.
  const home = realpath(input.resolvedHome);
  const prodHomes = new Set(input.productionHomes.map(realpath));
  const devHome = realpath(join(input.userHome, '.snaglet-dev'));
  const isProd = prodHomes.has(home);
  const databaseName = env.SNAGLET_DATABASE_NAME?.trim() || 'snaglet';

  let kind: ScriptTargetKind;
  if (isProd) kind = 'prod';
  else if (mode === 'preview') kind = 'preview';
  else if (mode === 'dev' || home === devHome) kind = 'dev';
  else kind = 'custom-home';

  // R2: the signals have to agree.
  if (isProd && (mode === 'dev' || mode === 'preview')) {
    throw new ScriptTargetError(
      `[db] Refusing: SNAGLET_ENV=${mode} but SNAGLET_HOME resolves to the production home (${home}). ` +
        'Nothing was written.'
    );
  }
  if (target && target !== kind) {
    const hint =
      target === 'dev' || target === 'preview' ? ` Set SNAGLET_ENV=${target} as well.` : '';
    throw new ScriptTargetError(
      `[db] Refusing: --target=${target} but the resolved target is ${kind} (${home}).${hint} ` +
        'Nothing was written.'
    );
  }

  // R3: production needs two deliberate signals.
  if (isProd) {
    const allow =
      env.SNAGLET_ALLOW_PROD_WRITE === '1' &&
      (!provenance || provenance.processEnvKeys.has('SNAGLET_ALLOW_PROD_WRITE'));
    if (target !== 'prod' || !allow) {
      throw new ScriptTargetError(
        `[db] Refusing to write to PRODUCTION (${home}) from a source checkout. Requires ` +
          '--target=prod AND SNAGLET_ALLOW_PROD_WRITE=1 exported in the shell. Nothing was written.'
      );
    }
  }

  return { kind, snagletHome: home, databaseName, url: null, source, dryRun };
}

/** The block printed (stderr) before anything connects. */
export function formatScriptTarget(script: ScriptName, target: ScriptTarget): string[] {
  const lines: string[] = [];
  if (target.kind === 'prod')
    lines.push(`[db] !! WRITING TO PRODUCTION (${target.snagletHome}) !!`);
  lines.push(`[db] target  : ${target.kind}  (source: ${target.source})`);
  if (target.url) {
    lines.push(`[db] url     : ${target.url}`);
  } else {
    lines.push(`[db] SNAGLET_HOME : ${target.snagletHome}`);
    lines.push(`[db] cluster : managed · ${join(target.snagletHome ?? '', 'postgres')}`);
  }
  lines.push(`[db] database: ${target.databaseName}`);
  lines.push(
    `[db] script  : ${script}${target.dryRun ? ' (dry run: nothing will be written)' : ''}`
  );
  return lines;
}

/**
 * CLI entry: resolve against the live process, print the target, and return
 * it. On refusal prints the reason, sets exit code 2 and returns null — the
 * caller must stop before opening the database.
 */
export function guardScriptTarget(
  script: ScriptName,
  argv: readonly string[] = process.argv.slice(2)
): ScriptTarget | null {
  try {
    const envHome = process.env.SNAGLET_HOME?.trim();
    const target = resolveScriptTarget({
      script,
      env: process.env,
      provenance: snagletEnvProvenance(),
      argv,
      productionHomes: productionDbHomes(),
      resolvedHome: envHome ? resolveConfiguredPath(envHome, 'SNAGLET_HOME') : resolveDbHome(),
      userHome: homedir(),
    });
    for (const line of formatScriptTarget(script, target)) console.error(line);
    return target;
  } catch (error: unknown) {
    if (error instanceof ScriptTargetError) {
      console.error(getErrorMessage(error));
      process.exitCode = error.exitCode;
      return null;
    }
    throw error;
  }
}
