import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  PGVECTOR_SOURCE,
  PGVECTOR_VERSION,
  POSTGRES_MINIMUM_MACOS_VERSION,
  POSTGRES_RUNTIME_ID,
  POSTGRES_SOURCE,
  POSTGRES_VERSION,
  POSTGRES_WINDOWS_BINARY,
  POSTGRES_WINDOWS_MANIFEST_REVISION,
} from '../../packages/db/runtime/postgres/version';
import { assertMachOSupportsMacOSVersion } from './macos-deployment-target';

const RUNTIME_MANIFEST = 'snaglet-postgres-runtime.json';
const REQUIRED_BINARIES = [
  'postgres',
  'initdb',
  'pg_ctl',
  'pg_dump',
  'pg_restore',
  'pg_config',
  'psql',
  'createdb',
  'dropdb',
] as const;

export interface PackagedPostgresMetadata {
  machOFiles: number;
  minimumMacOSVersion: string | null;
  pgvectorVersion: string;
  platform: string;
  postgresVersion: string;
  runtimeId: string;
  windowsManifestRevision?: string;
}

interface RuntimeManifest {
  minimumMacOSVersion?: string | null;
  pgvectorVersion: string;
  platform: string;
  postgresVersion: string;
  runtimeId: string;
  schemaVersion: number;
  sourceSha256?: { pgvector?: string; postgres?: string };
  windowsBinarySha256?: string;
  windowsManifestRevision?: string;
  windowsExecutableSha256?: Record<string, string>;
}

function requireFile(file: string, description: string): void {
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Packaged PostgreSQL ${description} is missing: ${file}`);
  }
}

function allFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new Error(`Unsupported packaged PostgreSQL file type: ${absolute}`);
    }
  };
  visit(root);
  return files;
}

function capture(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`
    );
  }
  return `${result.stdout}${result.stderr}`;
}

function isMachO(file: string): boolean {
  const result = spawnSync('/usr/bin/file', ['-b', file], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.includes('Mach-O');
}

function verifyDarwinMachO(file: string): void {
  assertMachOSupportsMacOSVersion(file, POSTGRES_MINIMUM_MACOS_VERSION);
  capture('/usr/bin/codesign', ['--verify', '--strict', file]);
  const signature = capture('/usr/bin/codesign', ['-d', '--verbose=4', file]);
  if (!/flags=.*\bruntime\b/.test(signature)) {
    throw new Error(`Packaged PostgreSQL Mach-O lacks hardened runtime signing: ${file}`);
  }

  const dependencies = capture('/usr/bin/otool', ['-L', file])
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' (compatibility version', 1)[0]?.trim())
    .filter((dependency): dependency is string => Boolean(dependency));
  for (const dependency of dependencies) {
    if (
      dependency.startsWith('@loader_path/') ||
      dependency.startsWith('@rpath/') ||
      dependency.startsWith('@executable_path/') ||
      dependency.startsWith('/usr/lib/') ||
      dependency.startsWith('/System/Library/')
    ) {
      continue;
    }
    throw new Error(
      `Packaged PostgreSQL Mach-O has a non-relocatable dependency: ${file} -> ${dependency}`
    );
  }
}

export function verifyPackagedPostgres(root: string): PackagedPostgresMetadata {
  const manifestPath = path.join(root, RUNTIME_MANIFEST);
  requireFile(manifestPath, 'runtime manifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeManifest;
  if (
    manifest.schemaVersion !== 2 ||
    manifest.runtimeId !== POSTGRES_RUNTIME_ID ||
    manifest.postgresVersion !== POSTGRES_VERSION ||
    manifest.pgvectorVersion !== PGVECTOR_VERSION ||
    manifest.platform !==
      (process.platform === 'darwin' && process.arch === 'arm64'
        ? 'darwin-arm64'
        : process.platform === 'linux' && process.arch === 'x64'
          ? 'linux-x64'
          : process.platform === 'win32' && process.arch === 'x64'
            ? 'win32-x64'
            : 'unsupported') ||
    manifest.sourceSha256?.postgres !== POSTGRES_SOURCE.sha256 ||
    manifest.sourceSha256?.pgvector !== PGVECTOR_SOURCE.sha256 ||
    manifest.minimumMacOSVersion !==
      (process.platform === 'darwin' ? POSTGRES_MINIMUM_MACOS_VERSION : null)
  ) {
    throw new Error(`Packaged PostgreSQL runtime manifest is invalid: ${manifestPath}`);
  }
  if (
    process.platform === 'win32' &&
    (manifest.windowsBinarySha256 !== POSTGRES_WINDOWS_BINARY.sha256 ||
      manifest.windowsManifestRevision !== POSTGRES_WINDOWS_MANIFEST_REVISION)
  ) {
    throw new Error(`Packaged PostgreSQL Windows runtime provenance is invalid: ${manifestPath}`);
  }

  for (const binary of REQUIRED_BINARIES) {
    const file = path.join(root, 'bin', `${binary}${process.platform === 'win32' ? '.exe' : ''}`);
    requireFile(file, `${binary} executable`);
    if (
      process.platform === 'win32' &&
      createHash('sha256').update(readFileSync(file)).digest('hex') !==
        manifest.windowsExecutableSha256?.[`${binary}.exe`]
    ) {
      throw new Error(`Packaged PostgreSQL UTF-8 executable hash is invalid: ${file}`);
    }
    if (process.platform !== 'win32' && (statSync(file).mode & 0o111) === 0) {
      throw new Error(`Packaged PostgreSQL executable bit is missing: ${file}`);
    }
  }

  // PostgreSQL drops the `postgresql/` suffix from pkglibdir/sharedir when the
  // install prefix itself contains "postgres" or "pgsql" (see
  // packages/db/runtime/postgres/binaries.ts), so the packaged layout may be
  // nested (lib/postgresql, share/postgresql) or flat (lib, share).
  const pgLibDir = statSync(path.join(root, 'lib', 'postgresql'), {
    throwIfNoEntry: false,
  })?.isDirectory()
    ? path.join(root, 'lib', 'postgresql')
    : path.join(root, 'lib');
  const pgShareDir = statSync(path.join(root, 'share', 'postgresql'), {
    throwIfNoEntry: false,
  })?.isDirectory()
    ? path.join(root, 'share', 'postgresql')
    : path.join(root, 'share');

  const librarySuffix =
    process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so';
  for (const extension of ['vector', 'pg_trgm']) {
    requireFile(
      path.join(pgLibDir, `${extension}.${librarySuffix}`),
      `${extension} extension library`
    );
    requireFile(
      path.join(pgShareDir, 'extension', `${extension}.control`),
      `${extension} extension control file`
    );
  }

  const extensionDirectory = path.join(pgShareDir, 'extension');
  const extensionAssets = readdirSync(extensionDirectory);
  if (!extensionAssets.includes(`vector--${manifest.pgvectorVersion}.sql`)) {
    throw new Error(`Packaged PostgreSQL vector ${manifest.pgvectorVersion} base SQL is missing`);
  }
  if (!extensionAssets.some((file) => /^vector--[^-]+--[^-]+\.sql$/.test(file))) {
    throw new Error('Packaged PostgreSQL vector upgrade SQL chain is missing');
  }
  if (!extensionAssets.includes('pg_trgm--1.3.sql')) {
    throw new Error('Packaged PostgreSQL pg_trgm base SQL is missing');
  }
  if (!extensionAssets.some((file) => /^pg_trgm--[^-]+--[^-]+\.sql$/.test(file))) {
    throw new Error('Packaged PostgreSQL pg_trgm upgrade SQL chain is missing');
  }

  requireFile(path.join(pgShareDir, 'postgres.bki'), 'catalog bootstrap data');
  if (!statSync(path.join(pgShareDir, 'timezone'), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Packaged PostgreSQL timezone data is missing');
  }
  if (!statSync(path.join(pgShareDir, 'tsearch_data'), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Packaged PostgreSQL text-search data is missing');
  }

  let machOFiles = 0;
  if (process.platform === 'darwin') {
    for (const file of allFiles(root)) {
      if (!isMachO(file)) continue;
      verifyDarwinMachO(file);
      machOFiles += 1;
    }
    if (machOFiles === 0) throw new Error('Packaged PostgreSQL contains no signed Mach-O files');
  }

  return {
    machOFiles,
    ...(process.platform === 'win32'
      ? { windowsManifestRevision: manifest.windowsManifestRevision }
      : {}),
    minimumMacOSVersion: manifest.minimumMacOSVersion ?? null,
    pgvectorVersion: manifest.pgvectorVersion,
    platform: manifest.platform,
    postgresVersion: manifest.postgresVersion,
    runtimeId: manifest.runtimeId,
  };
}
