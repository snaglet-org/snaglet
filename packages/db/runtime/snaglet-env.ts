import { config } from 'dotenv';
// Named import — the default CJS export is undefined under transforms without
// esModuleInterop (jest's unit:shared project), while `expand` works in both
// module worlds.
import { expand } from 'dotenv-expand';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

/**
 * SNAGLET_ENV mode loader — one place that maps a launch mode onto env files and
 * mode defaults, shared by the server config and the db package runtime.
 *
 * `SNAGLET_ENV` (dev | preview | prod) selects the mode. It is deliberately not
 * `NODE_ENV`: preview runs NODE_ENV=production on built code while still
 * needing non-production data isolation.
 *
 * Mode matrix:
 *
 * | Mode    | SNAGLET_HOME              | Database                     | NODE_ENV    |
 * | ------- | -------------------- | ---------------------------- | ----------- |
 * | dev     | ~/.snaglet-dev            | snaglet (dev cluster)             | development |
 * | preview | ~/.snaglet-dev (shared)   | snaglet_preview (same cluster)    | production  |
 * | prod    | nothing set — the default resolution chain (pointer → ~/.snaglet)    |
 *
 * Precedence per key, most to least binding:
 *   1. real process environment (explicit launcher/supervisor config)
 *   2. `.env.local`               (per-checkout overrides)
 *   3. `.env.<mode>`              (mode file, gitignored)
 *   4. `.env`                     (checkout base config)
 *   5. mode default               (this module)
 *   6. built-in resolution chain  (snaglet-home.ts / resolveDatabaseName defaults)
 *
 * Mode defaults never override explicit configuration: an explicit
 * `SNAGLET_DATABASE_URL` or `SNAGLET_HOME` set above the defaults always wins, and the
 * shadowed default is logged. With no `.env.dev` at all, `SNAGLET_ENV=dev` still
 * lands in `~/.snaglet-dev` via the mode default. `prod` has no env file and no
 * defaults, so it runs the same default resolution chain a real install gets.
 */

export type SnagletEnvMode = 'dev' | 'preview' | 'prod';

export const SNAGLET_ENV_MODES: readonly SnagletEnvMode[] = ['dev', 'preview', 'prod'];

/** Parse SNAGLET_ENV. Unset/blank means "no mode": the loader stays dormant. */
export function resolveSnagletEnvMode(env: NodeJS.ProcessEnv = process.env): SnagletEnvMode | null {
  const raw = env.SNAGLET_ENV?.trim();
  if (!raw) return null;
  if ((SNAGLET_ENV_MODES as readonly string[]).includes(raw)) return raw as SnagletEnvMode;
  throw new Error(
    `[snaglet-env] Invalid SNAGLET_ENV=${JSON.stringify(raw)}; expected one of: ${SNAGLET_ENV_MODES.join(', ')}`
  );
}

/** The mode env file name, or null for prod (production loads no mode file). */
export function snagletEnvFileName(mode: SnagletEnvMode): string | null {
  return mode === 'prod' ? null : `.env.${mode}`;
}

/**
 * Mode defaults — applied only for keys with no explicit value anywhere.
 * dev and preview share one home (and so one managed cluster); preview is
 * isolated from dev by database name, not by cluster.
 */
export function snagletModeDefaults(
  mode: SnagletEnvMode,
  userHome: string = homedir()
): Record<string, string> {
  switch (mode) {
    case 'dev':
      return { SNAGLET_HOME: join(userHome, '.snaglet-dev'), NODE_ENV: 'development' };
    case 'preview':
      return {
        SNAGLET_HOME: join(userHome, '.snaglet-dev'),
        SNAGLET_DATABASE_NAME: 'snaglet_preview',
        NODE_ENV: 'production',
      };
    case 'prod':
      return {};
  }
}

export interface SnagletEnvShadowedDefault {
  key: string;
  /** The explicit value that won. */
  value: string;
  /** The mode default that was NOT applied. */
  defaultValue: string;
  /** Where the winning value came from: 'process env' or an env file name. */
  source: string;
}

export interface SnagletEnvLoadResult {
  mode: SnagletEnvMode | null;
  /** Directory the env files were loaded from, or null when none was found. */
  root: string | null;
  loadedFiles: string[];
  /** Mode defaults written into process.env by this call. */
  appliedDefaults: Record<string, string>;
  /** Mode defaults suppressed by differing explicit configuration. */
  shadowedDefaults: SnagletEnvShadowedDefault[];
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Where each key in process.env came from, as recorded by the first
 * `loadSnagletEnvironment` call in this process (before any env file was loaded).
 * The db-script target guard reads it to tell a real shell export from a value
 * supplied by a checkout env file or a mode default. Later calls never
 * overwrite it: by then file values look like process env.
 */
export interface SnagletEnvProvenance {
  /** Keys present in the real process environment before any file loaded. */
  processEnvKeys: ReadonlySet<string>;
  /** First env file (by name, e.g. `.env.local`) that supplied each key. */
  fileSources: ReadonlyMap<string, string>;
  /** Mode defaults written into process.env by the loader. */
  appliedDefaults: Readonly<Record<string, string>>;
}

let firstLoadProvenance: SnagletEnvProvenance | null = null;

/** Provenance of the first env load in this process, or null if none ran. */
export function snagletEnvProvenance(): SnagletEnvProvenance | null {
  return firstLoadProvenance;
}

/**
 * Load env files and apply mode defaults into process.env.
 *
 * Walks up from `startDir` to the first directory containing any of
 * `.env.local` / `.env.<mode>` / `.env` and loads those present, earliest name
 * winning (dotenv override:false — the real process environment always wins).
 * Then fills mode defaults for keys still unset. Fully dormant when SNAGLET_ENV is
 * unset. Idempotent — a second call in the same process is a no-op. A bundled
 * server (`SNAGLET_BUNDLED=1`, baked in by the server bundler) skips the file walk
 * entirely and only applies mode defaults.
 */
export function loadSnagletEnvironment(
  startDir: string,
  options?: { stopDir?: string; log?: (line: string) => void; warn?: (line: string) => void }
): SnagletEnvLoadResult {
  const log = options?.log ?? ((line: string) => console.log(line));
  const warn = options?.warn ?? ((line: string) => console.warn(line));
  const mode = resolveSnagletEnvMode();
  const modeFile = mode ? snagletEnvFileName(mode) : null;
  const fileNames = ['.env.local', ...(modeFile ? [modeFile] : []), '.env'];

  let root: string | null = null;
  // A bundled server (SNAGLET_BUNDLED is defined at build time by
  // apps/server/scripts/bundle.mjs) receives its whole configuration from the
  // launcher's process environment and never reads env files: the walk from
  // inside Snaglet.app/Contents/Resources/server would otherwise climb out of the
  // bundle and, for an app packaged under the repository, load the checkout's
  // own .env (LOG_LEVEL, SNAGLET_ENV, ...) into a production sidecar.
  const bundled = process.env.SNAGLET_BUNDLED === '1';
  let currentDir = startDir;
  while (!bundled) {
    if (fileNames.some((name) => existsSync(join(currentDir, name)))) {
      root = currentDir;
      break;
    }
    if (currentDir === options?.stopDir || currentDir === dirname(currentDir)) break;
    currentDir = dirname(currentDir);
  }

  // Keys explicitly present in the process environment before any file loads.
  const processEnvKeys = new Set(
    Object.keys(process.env).filter((key) => process.env[key] !== undefined)
  );
  // First env file that carries each key (files are loaded in precedence order).
  const fileSources = new Map<string, string>();
  const loadedFiles: string[] = [];
  if (root) {
    for (const name of fileNames) {
      const envPath = join(root, name);
      if (!existsSync(envPath)) continue;
      const result = config({ path: envPath, override: false });
      expand(result);
      loadedFiles.push(envPath);
      for (const key of Object.keys(result.parsed ?? {})) {
        if (!fileSources.has(key)) fileSources.set(key, name);
      }
    }
  }

  const appliedDefaults: Record<string, string> = {};
  const shadowedDefaults: SnagletEnvShadowedDefault[] = [];
  if (mode) {
    for (const [key, defaultValue] of Object.entries(snagletModeDefaults(mode))) {
      const current = process.env[key];
      if (!isSet(current)) {
        process.env[key] = defaultValue;
        appliedDefaults[key] = defaultValue;
        continue;
      }
      if (current !== defaultValue) {
        const source = processEnvKeys.has(key) ? 'process env' : (fileSources.get(key) ?? '.env');
        shadowedDefaults.push({ key, value: current, defaultValue, source });
      }
    }
    if (Object.keys(appliedDefaults).length > 0) {
      const summary = Object.entries(appliedDefaults)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
      log(`[snaglet-env] ${mode}: applied mode defaults ${summary}`);
    }
    for (const shadowed of shadowedDefaults) {
      warn(
        `[snaglet-env] ${mode}: ${shadowed.key}=${JSON.stringify(shadowed.value)} from ${shadowed.source} ` +
          `overrides the ${mode} default ${JSON.stringify(shadowed.defaultValue)} — explicit configuration wins`
      );
    }
  }

  if (!firstLoadProvenance) {
    firstLoadProvenance = {
      processEnvKeys,
      fileSources,
      appliedDefaults: { ...appliedDefaults },
    };
  }

  return { mode, root, loadedFiles, appliedDefaults, shadowedDefaults };
}
