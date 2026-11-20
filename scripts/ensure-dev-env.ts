#!/usr/bin/env tsx
/**
 * First-run dev setup — makes `pnpm dev` work on a fresh clone without hand
 * editing `.env`.
 *
 * Idempotent and conservative: it only ever
 *   1. copies `.env.example` to `.env` when no `.env` exists, and
 *   2. fills in a freshly generated `CREDENTIAL_ENCRYPTION_KEY` when the key is
 *      unset everywhere the dev server would look for it.
 *
 * It never rewrites an existing value, never touches any other line, and
 * refuses to generate a key when doing so could orphan credentials that were
 * already encrypted with a key we no longer have: an existing managed cluster
 * or an external `SNAGLET_DATABASE_URL`. That mirrors the packaged app's
 * `credential_key()` guard in apps/desktop/src-tauri/src/sidecar.rs.
 *
 * The effective key and data paths are resolved the way `SNAGLET_ENV=dev` resolves
 * them at runtime (process env > .env.local > .env.dev > .env > dev defaults),
 * not from hardcoded `~/.snaglet-dev`.
 *
 * No network, no PostgreSQL build, no model downloads.
 */

import { randomBytes } from 'node:crypto';
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv, populate as populateDotenv } from 'dotenv';
import { expand as expandDotenv } from 'dotenv-expand';
import { resolveConfiguredPath } from '@snaglet/shared/utils/paths';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const KEY_NAME = 'CREDENTIAL_ENCRYPTION_KEY';
const KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
/** Env files the dev server loads, in precedence order (earliest wins). */
const DEV_ENV_FILES = ['.env.local', '.env.dev', '.env'] as const;

export interface EnsureDevEnvOptions {
  /** Checkout root holding `.env.example` and the env files. */
  repoRoot?: string;
  /** Process environment to honor ahead of env files. */
  env?: NodeJS.ProcessEnv;
  /** User home used for the `~/.snaglet-dev` default and `~` expansion. */
  userHome?: string;
  log?: (line: string) => void;
}

export type EnsureDevEnvAction = 'created-env-file' | 'generated-key';

export interface EnsureDevEnvResult {
  actions: EnsureDevEnvAction[];
  /** Env file the key was written to, when one was generated. */
  keyFile: string | null;
  snagletHome: string;
  dataDir: string;
}

interface EffectiveValue {
  value: string | undefined;
  /** 'process env', an env file name, or null when unset everywhere. */
  source: string | null;
}

type DevEnvFileName = (typeof DEV_ENV_FILES)[number];

function isDevEnvFileName(name: string | null): name is DevEnvFileName {
  return (DEV_ENV_FILES as readonly string[]).includes(name ?? '');
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/** Read one env file without mutating process.env; `{}` when absent. */
function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  return parseDotenv(readFileSync(filePath, 'utf8'));
}

/**
 * Resolve every key the way `loadSnagletEnvironment` does for `SNAGLET_ENV=dev`: the
 * process environment always wins (dotenv override:false), then the env files
 * in precedence order, then the dev mode defaults. Also reports where each
 * key's effective value came from so a key that is present-but-empty can be
 * filled in the file that already mentions it.
 *
 * Fidelity note: dotenv-expand only short-circuits on a *truthy* existing
 * value and writes its expansion back, so a present-but-empty key in a
 * higher-precedence file (or in the process env) does not shadow a later
 * non-empty value. The runtime and this helper share that behavior because
 * both go through `expand()` per file.
 */
function resolveDevEnvironment(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  userHome: string
): { values: Record<string, string>; sources: Map<string, string> } {
  const values: Record<string, string> = {};
  const sources = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    values[key] = value;
    sources.set(key, 'process env');
  }
  for (const name of DEV_ENV_FILES) {
    const parsed = readEnvFile(join(repoRoot, name));
    if (Object.keys(parsed).length === 0) continue;
    // Same two steps as the runtime's `expand(config({ path }))`: populate
    // every parsed key first (override:false — an existing key wins) so that
    // forward references like `SNAGLET_HOME=$CUSTOM` + `CUSTOM=/x` resolve, then
    // expand, which also writes back over a present-but-empty value.
    const before = new Map(Object.entries(values));
    populateDotenv(values, parsed, { override: false });
    expandDotenv({ parsed, processEnv: values });
    for (const key of Object.keys(parsed)) {
      if (!before.has(key) || before.get(key) !== values[key]) sources.set(key, name);
    }
  }
  if (!isSet(values.SNAGLET_HOME)) values.SNAGLET_HOME = join(userHome, '.snaglet-dev');
  return { values, sources };
}

function effectiveKey(
  values: Record<string, string>,
  sources: Map<string, string>
): EffectiveValue {
  return { value: values[KEY_NAME], source: sources.get(KEY_NAME) ?? null };
}

/** Replace the file atomically so a concurrent reader never sees a torn write. */
function writeFileAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const mode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : 0o600;
  writeFileSync(tempPath, content, { mode });
  renameSync(tempPath, filePath);
}

/**
 * Put `KEY=value` into an env file: fill the first `KEY=` line whose value is
 * empty, otherwise append. Every other byte of the file is preserved.
 */
export function upsertEnvValue(content: string, key: string, value: string): string {
  const lines = content.split('\n');
  const emptyAssignment = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*$`);
  const index = lines.findIndex((line) => emptyAssignment.test(line));
  if (index !== -1) {
    lines[index] = `${key}=${value}`;
    return lines.join('\n');
  }
  const needsNewline = content.length > 0 && !content.endsWith('\n');
  return `${content}${needsNewline ? '\n' : ''}${key}=${value}\n`;
}

export function ensureDevEnvironment(options: EnsureDevEnvOptions = {}): EnsureDevEnvResult {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const log = options.log ?? ((line: string) => console.log(line));
  const actions: EnsureDevEnvAction[] = [];

  const envPath = join(repoRoot, '.env');
  const examplePath = join(repoRoot, '.env.example');
  if (!existsSync(envPath)) {
    if (!existsSync(examplePath)) {
      throw new Error(`[dev-env] neither .env nor .env.example exists in ${repoRoot}`);
    }
    // COPYFILE_EXCL: if a concurrent setup run created `.env` first, keep
    // theirs rather than clobbering a key they may already have written.
    try {
      copyFileSync(examplePath, envPath, fsConstants.COPYFILE_EXCL);
      actions.push('created-env-file');
      log(`[dev-env] created .env from .env.example`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  const { values, sources } = resolveDevEnvironment(repoRoot, env, userHome);
  // `~` expands against `userHome` (injectable for tests) before the shared
  // validator rejects bare relative paths, exactly as the runtime does.
  const expandHome = (value: string, source: string) =>
    resolveConfiguredPath(value.replace(/^~(?=$|[\\/])/, userHome), source);
  const snagletHome = expandHome(values.SNAGLET_HOME, 'SNAGLET_HOME');
  const dataDir = isSet(values.SNAGLET_PG_DATA_DIR)
    ? expandHome(values.SNAGLET_PG_DATA_DIR, 'SNAGLET_PG_DATA_DIR')
    : join(snagletHome, 'postgres');

  // Validate the raw value: the runtime regex rejects surrounding whitespace,
  // so a whitespace-only key is "malformed", not "unset".
  const key = effectiveKey(values, sources);
  if (key.value !== undefined && key.value !== '') {
    if (!KEY_PATTERN.test(key.value)) {
      throw new Error(
        `[dev-env] ${KEY_NAME} from ${key.source ?? 'env'} is malformed (expected 64 hex characters). ` +
          'Refusing to replace it: a new key would make credentials already encrypted with it unrecoverable. ' +
          'Fix or remove the value by hand.'
      );
    }
    return { actions, keyFile: null, snagletHome, dataDir };
  }

  // Unset (or present-but-empty) everywhere. Generating is only safe when no
  // database could already hold rows encrypted with a key we don't have.
  if (isSet(values.SNAGLET_DATABASE_URL)) {
    throw new Error(
      `[dev-env] ${KEY_NAME} is not set but SNAGLET_DATABASE_URL points at an external database. ` +
        `Refusing to generate a key: that database may already hold credentials encrypted with another key. ` +
        `Set ${KEY_NAME} to the key that database was encrypted with.`
    );
  }
  if (existsSync(join(dataDir, 'PG_VERSION'))) {
    throw new Error(
      `[dev-env] ${KEY_NAME} is not set but a managed PostgreSQL cluster already exists at ${dataDir}. ` +
        `Refusing to generate a key: stored credentials would become unrecoverable. ` +
        `Restore the original ${KEY_NAME}, or move/delete that cluster to start fresh.`
    );
  }
  // Fill the first env file that already mentions the (empty) key; fall back
  // to `.env` when none does or when the empty value came from the process
  // environment (an empty process value never shadows a file, see above).
  const targetName: DevEnvFileName = isDevEnvFileName(key.source) ? key.source : '.env';
  const targetPath = join(repoRoot, targetName);
  const generated = randomBytes(32).toString('hex');
  const current = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
  writeFileAtomic(targetPath, upsertEnvValue(current, KEY_NAME, generated));
  actions.push('generated-key');
  log(
    `[dev-env] generated ${KEY_NAME} in ${targetName} (keep this file; it decrypts stored credentials)`
  );
  return { actions, keyFile: targetPath, snagletHome, dataDir };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === SCRIPT_PATH) {
  try {
    ensureDevEnvironment();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
