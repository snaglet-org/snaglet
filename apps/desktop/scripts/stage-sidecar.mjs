import crossSpawn from 'cross-spawn';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_STAGED_PATH } from '../../../build/scripts/staged-path-policy.mjs';
import { stageWindowsCrt } from '../../../build/scripts/windows-crt.mjs';
import { signServerFsevents } from './lib/signServerFsevents.mjs';
import targetModule from './ripgrep-target.cjs';
const {
  RIPGREP_VERSION: ripgrepVersion,
  pinnedRipgrepArchiveSha256,
  ripgrepTarget: resolveRipgrepTarget,
} = targetModule;
import ripgrepStageModule from './ripgrep-stage.cjs';
const { validateRipgrepCache } = ripgrepStageModule;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(desktopDirectory, '..', '..');
const tauriDirectory = path.join(desktopDirectory, 'src-tauri');
const nodeVersion = '22.22.0';
const profileName = process.env.SNAGLET_BUILD_PROFILE ?? 'desktop-preview';
if (profileName !== 'desktop-preview' && profileName !== 'desktop-production') {
  throw new Error(`Unsupported desktop staging profile: ${profileName}`);
}
const production = profileName === 'desktop-production';
const profileOutput = path.resolve(
  repositoryRoot,
  process.env.SNAGLET_BUILD_OUTPUT ?? `dist/${profileName}`
);
const outputRelative = path.relative(path.join(repositoryRoot, 'dist'), profileOutput);
if (
  !outputRelative ||
  outputRelative === '..' ||
  outputRelative.startsWith(`..${path.sep}`) ||
  path.isAbsolute(outputRelative)
) {
  throw new Error(
    'SNAGLET_BUILD_OUTPUT must be a profile directory inside the repository dist directory'
  );
}
const serverInput = path.resolve(
  repositoryRoot,
  process.env.SNAGLET_STAGE_SERVER_INPUT ?? 'dist/bundle'
);
const stagedRoot = path.join(profileOutput, 'staged');
const stagedServer = path.join(stagedRoot, 'server');
const stagedCli = path.join(stagedRoot, 'cli');
const stagedPostgres = path.join(stagedRoot, 'pg');
const runtimeDirectory = path.join(stagedRoot, 'runtime');
const cliInput = path.join(repositoryRoot, 'packages', 'snaglet-cli');
const minimumMacOSVersion =
  process.platform === 'darwin' ? process.env.MACOSX_DEPLOYMENT_TARGET?.trim() || '14.0' : null;

function fail(message) {
  throw new Error(`[stage-sidecar] ${message}`);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function walkFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else fail(`unsupported staged input ${absolute}`);
    }
  };
  visit(root);
  return files;
}

function copyRuntimeTree(sourceRoot, destinationRoot) {
  const visit = (source, destination) => {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const sourcePath = path.join(source, entry.name);
      const destinationPath = path.join(destination, entry.name);
      if (entry.isDirectory()) {
        visit(sourcePath, destinationPath);
        continue;
      }
      if (entry.isFile()) {
        cpSync(sourcePath, destinationPath, { preserveTimestamps: false });
        continue;
      }
      if (entry.isSymbolicLink()) {
        const resolved = realpathSync(sourcePath);
        const relative = path.relative(sourceRoot, resolved);
        if (
          relative.startsWith('..') ||
          path.isAbsolute(relative) ||
          !statSync(resolved).isFile()
        ) {
          fail(`unsafe managed PostgreSQL runtime symlink: ${sourcePath} -> ${resolved}`);
        }
        // Tauri resources must not retain links back into the build cache.
        // Materialize the in-tree target as a regular relocatable file.
        cpSync(resolved, destinationPath, { preserveTimestamps: false });
        continue;
      }
      fail(`unsupported managed PostgreSQL runtime input: ${sourcePath}`);
    }
  };
  visit(sourceRoot, destinationRoot);
}

function targetTriple() {
  if (process.platform === 'darwin')
    return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (process.platform === 'linux')
    return process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
  fail(`unsupported platform ${process.platform}/${process.arch}`);
}

function nodeDistribution() {
  if (process.platform === 'darwin') return `node-v${nodeVersion}-darwin-${process.arch}`;
  if (process.platform === 'linux')
    return `node-v${nodeVersion}-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  if (process.platform === 'win32') return `node-v${nodeVersion}-win-x64`;
  fail(`unsupported platform ${process.platform}`);
}

function run(command, args, cwd, env = process.env) {
  console.log(`[stage-sidecar] $ ${command} ${args.join(' ')}`);
  const result = crossSpawn.sync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} failed with status ${result.status ?? 'unknown'}`);
}

function capture(command, args, cwd, env = process.env) {
  const result = crossSpawn.sync(command, args, { cwd, encoding: 'utf8', env, windowsHide: true });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `${command} failed with status ${result.status ?? 'unknown'}: ${(result.stderr || result.stdout).trim()}`
    );
  }
  return result.stdout.trim();
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) fail(`download failed (${response.status}) for ${url}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

function ripgrepTarget() {
  return resolveRipgrepTarget(process.platform, process.arch);
}

async function stageRipgrep() {
  const target = ripgrepTarget();
  const extension = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const archiveName = `ripgrep-${ripgrepVersion}-${target}.${extension}`;
  const cacheDirectory = path.join(repositoryRoot, '.cache', 'ripgrep', ripgrepVersion, target);
  const archive = path.join(cacheDirectory, archiveName);
  const expected = pinnedRipgrepArchiveSha256(target);
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const cachedBinary = path.join(cacheDirectory, binaryName);
  const cacheMetadata = path.join(cacheDirectory, 'verified.json');
  const cachedLicense = path.join(cacheDirectory, 'LICENSE-MIT');
  mkdirSync(cacheDirectory, { recursive: true });
  if (!existsSync(cachedBinary) || !existsSync(cacheMetadata) || !existsSync(cachedLicense)) {
    await download(
      `https://github.com/BurntSushi/ripgrep/releases/download/${ripgrepVersion}/${archiveName}`,
      archive
    );
    // Compare against the checksum pinned in ripgrep-target.cjs, not one
    // fetched from the same release: only the vetted archive is accepted.
    const actual = sha256(archive);
    if (actual !== expected) {
      rmSync(archive, { force: true });
      fail(
        `ripgrep archive checksum mismatch for ${archiveName}: got ${actual}, pinned ${expected}`
      );
    }
    const extractDirectory = path.join(cacheDirectory, 'extract');
    rmSync(extractDirectory, { recursive: true, force: true });
    mkdirSync(extractDirectory, { recursive: true });
    run(
      process.platform === 'win32' ? 'tar.exe' : 'tar',
      process.platform === 'win32'
        ? ['-xf', archive, '-C', extractDirectory]
        : ['-xzf', archive, '-C', extractDirectory],
      cacheDirectory
    );
    const source = path.join(extractDirectory, `ripgrep-${ripgrepVersion}-${target}`, binaryName);
    if (!existsSync(source)) fail(`ripgrep executable missing after extraction: ${source}`);
    cpSync(source, cachedBinary);
    const licenseSource = path.join(
      extractDirectory,
      `ripgrep-${ripgrepVersion}-${target}`,
      'LICENSE-MIT'
    );
    if (!existsSync(licenseSource))
      fail(`ripgrep license missing after extraction: ${licenseSource}`);
    cpSync(licenseSource, cachedLicense);
    if (process.platform !== 'win32') chmodSync(cachedBinary, 0o755);
    writeFileSync(
      cacheMetadata,
      `${JSON.stringify({ archive: archiveName, archiveSha256: actual, binarySha256: sha256(cachedBinary), licenseSha256: sha256(cachedLicense), ripgrepVersion, target }, null, 2)}\n`
    );
    rmSync(archive, { force: true });
    rmSync(extractDirectory, { recursive: true, force: true });
  }
  const metadata = JSON.parse(readFileSync(cacheMetadata, 'utf8'));
  try {
    validateRipgrepCache(cachedBinary, cachedLicense, metadata, ripgrepVersion, target);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const destinationRoot = path.join(stagedRoot, 'rg');
  mkdirSync(destinationRoot, { recursive: true });
  cpSync(cachedBinary, path.join(destinationRoot, binaryName));
  if (process.platform !== 'win32') chmodSync(path.join(destinationRoot, binaryName), 0o755);
  cpSync(cachedLicense, path.join(destinationRoot, 'LICENSE-MIT'));
  return {
    archiveSha256: expected,
    executable: `rg/${binaryName}`,
    target,
    version: ripgrepVersion,
  };
}

async function stageNodeRuntime() {
  const triple = targetTriple();
  const executableName =
    process.platform === 'win32' ? `snaglet-node-${triple}.exe` : `snaglet-node-${triple}`;
  const destination = path.join(runtimeDirectory, executableName);
  const cacheDirectory = path.join(repositoryRoot, '.cache', 'node-runtime', nodeVersion, triple);
  const cachedBinary = path.join(cacheDirectory, executableName);
  const cacheMetadata = path.join(cacheDirectory, 'verified.json');
  const cachedLicense = path.join(cacheDirectory, 'LICENSE');

  if (!existsSync(cachedBinary) || !existsSync(cacheMetadata)) {
    mkdirSync(cacheDirectory, { recursive: true });
    const distribution = nodeDistribution();
    const extension = process.platform === 'win32' ? 'zip' : 'tar.gz';
    const archiveName = `${distribution}.${extension}`;
    const archive = path.join(cacheDirectory, archiveName);
    const checksums = path.join(cacheDirectory, 'SHASUMS256.txt');
    const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
    await download(`${baseUrl}/${archiveName}`, archive);
    await download(`${baseUrl}/SHASUMS256.txt`, checksums);
    const expected = readFileSync(checksums, 'utf8')
      .split('\n')
      .find((line) => line.trim().endsWith(archiveName))
      ?.trim()
      .split(/\s+/)[0];
    if (!expected) fail(`official checksum missing for ${archiveName}`);
    const actual = sha256(archive);
    if (actual !== expected) fail(`Node archive checksum mismatch: ${actual} != ${expected}`);

    const extractDirectory = path.join(cacheDirectory, 'extract');
    rmSync(extractDirectory, { recursive: true, force: true });
    mkdirSync(extractDirectory, { recursive: true });
    // Windows includes bsdtar, which extracts ZIP archives without an extra unzip installation.
    if (extension === 'zip')
      run('tar.exe', ['-xf', archive, '-C', extractDirectory], cacheDirectory);
    else run('tar', ['-xzf', archive, '-C', extractDirectory], cacheDirectory);
    const source = path.join(
      extractDirectory,
      distribution,
      process.platform === 'win32' ? 'node.exe' : 'bin/node'
    );
    if (!existsSync(source)) fail(`Node executable missing after extraction: ${source}`);
    cpSync(source, cachedBinary);
    if (process.platform !== 'win32') chmodSync(cachedBinary, 0o755);
    const licenseSource = path.join(extractDirectory, distribution, 'LICENSE');
    if (existsSync(licenseSource)) cpSync(licenseSource, cachedLicense);
    writeFileSync(
      cacheMetadata,
      `${JSON.stringify({ archive: archiveName, archiveSha256: actual, binarySha256: sha256(cachedBinary), nodeVersion }, null, 2)}\n`
    );
    rmSync(archive, { force: true });
    rmSync(checksums, { force: true });
    rmSync(extractDirectory, { recursive: true, force: true });
  }

  const metadata = JSON.parse(readFileSync(cacheMetadata, 'utf8'));
  if (metadata.nodeVersion !== nodeVersion || metadata.binarySha256 !== sha256(cachedBinary))
    fail('cached Node runtime failed integrity verification');
  mkdirSync(runtimeDirectory, { recursive: true });
  cpSync(cachedBinary, destination);
  if (process.platform !== 'win32') chmodSync(destination, 0o755);
  // Tauri bundles the sidecar executable on its own (externalBin), so Node's
  // license ships in the server resources that this runtime executes.
  if (existsSync(cachedLicense)) {
    cpSync(cachedLicense, path.join(stagedServer, 'node-LICENSE'));
  } else {
    console.warn(
      `[stage-sidecar] Node license missing from ${cacheDirectory}; delete that cache to re-download it so the app ships Node's license`
    );
  }
  return { executableName, sha256: sha256(destination), triple };
}

const POSTGRES_RUNTIME_MANIFEST = 'snaglet-postgres-runtime.json';
const REQUIRED_POSTGRES_BINARIES = [
  'postgres',
  'initdb',
  'pg_ctl',
  'pg_dump',
  'pg_restore',
  'pg_config',
  'psql',
  'createdb',
  'dropdb',
];

function machODescription(file) {
  if (process.platform !== 'darwin') return null;
  const result = crossSpawn.sync('/usr/bin/file', ['-b', file], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.includes('Mach-O') ? result.stdout.trim() : null;
}

function signPostgresRuntime(root) {
  if (process.platform !== 'darwin') return { identity: null, machOFiles: 0 };
  const identity = process.env.APPLE_SIGNING_IDENTITY?.trim() || '-';
  const entitlements = path.join(profileOutput, '.postgres-adhoc-entitlements.plist');
  if (identity === '-') {
    // Hardened runtime enables library validation, but ad hoc signatures have
    // no Team ID and therefore cannot load one another without this narrow
    // local-preview entitlement. Real release identities retain validation.
    writeFileSync(
      entitlements,
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>\n'
    );
  }
  let machOFiles = 0;
  try {
    for (const file of walkFiles(root)) {
      const description = machODescription(file);
      if (!description) continue;
      const args = ['--force', '--sign', identity, '--options', 'runtime'];
      if (identity === '-') args.push('--timestamp=none');
      if (identity === '-' && description.includes('executable')) {
        args.push('--entitlements', entitlements);
      }
      args.push(file);
      run('/usr/bin/codesign', args, repositoryRoot);
      run('/usr/bin/codesign', ['--verify', '--strict', file], repositoryRoot);
      machOFiles += 1;
    }
  } finally {
    rmSync(entitlements, { force: true });
  }
  return { identity: identity === '-' ? 'adhoc' : identity, machOFiles };
}

function stagePostgresRuntime() {
  const runtimeEnvironment = { ...process.env };
  delete runtimeEnvironment.SNAGLET_PG_BINDIR;
  delete runtimeEnvironment.SNAGLET_PG_OWNED;
  run('pnpm', ['pg:runtime:build', '--strict'], repositoryRoot, runtimeEnvironment);
  const runtimeIdentity = JSON.parse(
    capture(
      'pnpm',
      [
        '--silent',
        '--filter',
        '@snaglet/db',
        'exec',
        'tsx',
        'scripts/print-postgres-runtime.ts',
        '--json',
      ],
      repositoryRoot,
      runtimeEnvironment
    )
  );
  if (!runtimeIdentity.rootDir) fail('managed PostgreSQL runtime path command returned no path');
  const sourceRoot = path.resolve(runtimeIdentity.rootDir);
  const manifestPath = path.join(sourceRoot, POSTGRES_RUNTIME_MANIFEST);
  if (!statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) {
    fail(`managed PostgreSQL runtime manifest missing: ${manifestPath}`);
  }
  const metadata = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const expectedPlatform =
    process.platform === 'darwin' && process.arch === 'arm64'
      ? 'darwin-arm64'
      : process.platform === 'linux' && process.arch === 'x64'
        ? 'linux-x64'
        : process.platform === 'win32' && process.arch === 'x64'
          ? 'win32-x64'
          : null;
  if (
    metadata.schemaVersion !== 2 ||
    metadata.runtimeId !== runtimeIdentity.runtimeId ||
    metadata.postgresVersion !== runtimeIdentity.postgresVersion ||
    metadata.pgvectorVersion !== runtimeIdentity.pgvectorVersion ||
    metadata.minimumMacOSVersion !== minimumMacOSVersion ||
    metadata.minimumMacOSVersion !== runtimeIdentity.minimumMacOSVersion ||
    metadata.platform !== expectedPlatform ||
    metadata.sourceSha256?.postgres !== runtimeIdentity.sourceSha256?.postgres ||
    metadata.sourceSha256?.pgvector !== runtimeIdentity.sourceSha256?.pgvector
  ) {
    fail(`managed PostgreSQL runtime identity is incompatible at ${sourceRoot}`);
  }
  if (
    process.platform === 'win32' &&
    (!runtimeIdentity.windowsBinarySha256 ||
      metadata.windowsBinarySha256 !== runtimeIdentity.windowsBinarySha256 ||
      !runtimeIdentity.windowsManifestRevision ||
      metadata.windowsManifestRevision !== runtimeIdentity.windowsManifestRevision)
  ) {
    fail(`managed PostgreSQL Windows runtime provenance is incompatible at ${sourceRoot}`);
  }
  for (const directory of ['bin', 'lib', 'share']) {
    const source = path.join(sourceRoot, directory);
    if (!statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
      fail(`managed PostgreSQL runtime directory missing: ${source}`);
    }
    copyRuntimeTree(source, path.join(stagedPostgres, directory));
  }
  cpSync(manifestPath, path.join(stagedPostgres, POSTGRES_RUNTIME_MANIFEST));
  let licenseFiles = 0;
  for (const entry of readdirSync(sourceRoot)) {
    if (
      /license|copyright|readme/i.test(entry) &&
      statSync(path.join(sourceRoot, entry)).isFile()
    ) {
      cpSync(path.join(sourceRoot, entry), path.join(stagedPostgres, entry));
      if (/license|copyright/i.test(entry)) licenseFiles += 1;
    }
  }
  // An older cached runtime may have no license texts.
  if (licenseFiles === 0) {
    console.warn(
      `[stage-sidecar] managed PostgreSQL runtime ${sourceRoot} has no license files; rebuild it with pnpm pg:runtime:build --strict --force so the app ships them`
    );
  }

  // PostgreSQL drops the `postgresql/` suffix from pkglibdir/sharedir when the
  // install prefix itself contains "postgres" or "pgsql" (see
  // packages/db/runtime/postgres/binaries.ts), so the staged layout may be
  // nested (lib/postgresql, share/postgresql) or flat (lib, share). Detect
  // which one this runtime uses instead of hardcoding it.
  const pgLibRelative = statSync(path.join(stagedPostgres, 'lib/postgresql'), {
    throwIfNoEntry: false,
  })?.isDirectory()
    ? 'lib/postgresql'
    : 'lib';
  const pgShareRelative = statSync(path.join(stagedPostgres, 'share/postgresql'), {
    throwIfNoEntry: false,
  })?.isDirectory()
    ? 'share/postgresql'
    : 'share';

  // Development headers, static archives, docs, and locale catalogs are not
  // used by the packaged server. Keep bin/lib/share runtime data, including
  // timezone and extension SQL/control files.
  for (const relative of [
    'lib/pkgconfig',
    `${pgLibRelative}/pgxs`,
    'share/doc',
    'share/locale',
    'share/man',
  ]) {
    rmSync(path.join(stagedPostgres, relative), { recursive: true, force: true });
  }
  for (const file of walkFiles(path.join(stagedPostgres, 'lib'))) {
    if (file.endsWith('.a') || file.endsWith('.lib') || file.endsWith('.pdb'))
      rmSync(file, { force: true });
  }
  for (const developmentBinary of ['pg_test_fsync', 'pg_test_timing']) {
    rmSync(
      path.join(
        stagedPostgres,
        'bin',
        `${developmentBinary}${process.platform === 'win32' ? '.exe' : ''}`
      ),
      { force: true }
    );
  }
  for (const file of walkFiles(stagedPostgres)) {
    const relative = `pg/${path.relative(stagedPostgres, file).split(path.sep).join('/')}`;
    if (FORBIDDEN_STAGED_PATH.test(relative)) {
      fail(`forbidden staged PostgreSQL path: ${relative}`);
    }
  }

  for (const binary of REQUIRED_POSTGRES_BINARIES) {
    const executable = path.join(
      stagedPostgres,
      'bin',
      `${binary}${process.platform === 'win32' ? '.exe' : ''}`
    );
    if (!statSync(executable, { throwIfNoEntry: false })?.isFile()) {
      fail(`required PostgreSQL executable missing: ${executable}`);
    }
    if (
      process.platform === 'win32' &&
      sha256(executable) !== metadata.windowsExecutableSha256?.[`${binary}.exe`]
    ) {
      fail(`PostgreSQL UTF-8 executable hash mismatch: ${executable}`);
    }
    if (process.platform !== 'win32') chmodSync(executable, 0o755);
  }
  const extensionSuffix =
    process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so';
  for (const asset of [
    `${pgLibRelative}/vector.${extensionSuffix}`,
    `${pgLibRelative}/pg_trgm.${extensionSuffix}`,
    `${pgShareRelative}/extension/vector.control`,
    `${pgShareRelative}/extension/pg_trgm.control`,
  ]) {
    if (!statSync(path.join(stagedPostgres, asset), { throwIfNoEntry: false })?.isFile()) {
      fail(`required PostgreSQL extension asset missing: ${asset}`);
    }
  }

  const signing = signPostgresRuntime(stagedPostgres);
  return {
    bin: 'pg/bin',
    machOFiles: signing.machOFiles,
    minimumMacOSVersion: metadata.minimumMacOSVersion,
    platform: metadata.platform,
    pgvectorVersion: metadata.pgvectorVersion,
    postgresVersion: metadata.postgresVersion,
    root: 'pg',
    runtimeId: metadata.runtimeId,
    signingIdentity: signing.identity,
    ...(process.platform === 'win32'
      ? { windowsManifestRevision: metadata.windowsManifestRevision }
      : {}),
  };
}

function validateServerInput() {
  if (!statSync(serverInput, { throwIfNoEntry: false })?.isDirectory())
    fail(`prebuilt server input missing: ${serverInput}`);
  for (const required of ['server.mjs', 'static/web/index.html']) {
    if (!statSync(path.join(serverInput, required), { throwIfNoEntry: false })?.isFile())
      fail(`required prebuilt input missing: ${required}`);
  }
  if (statSync(path.join(serverInput, 'pg'), { throwIfNoEntry: false })) {
    fail('generic server bundle must not contain the desktop-only PostgreSQL runtime');
  }
  for (const file of walkFiles(serverInput)) {
    const relative = path.relative(serverInput, file).split(path.sep).join('/');
    if (FORBIDDEN_STAGED_PATH.test(relative)) fail(`forbidden staged input: ${relative}`);
  }
}

function stageCli() {
  for (const required of ['bin/snaglet.mjs', 'src/sdk-runtime.mjs']) {
    if (!statSync(path.join(cliInput, required), { throwIfNoEntry: false })?.isFile())
      fail(`required CLI input missing: ${required}`);
  }
  mkdirSync(stagedCli, { recursive: true });
  for (const entry of ['bin', 'src']) {
    cpSync(path.join(cliInput, entry), path.join(stagedCli, entry), {
      recursive: true,
      preserveTimestamps: false,
    });
  }
  for (const file of walkFiles(stagedCli)) {
    const relative = path.relative(stagedCli, file).split(path.sep).join('/');
    if (FORBIDDEN_STAGED_PATH.test(relative)) fail(`forbidden staged CLI input: ${relative}`);
  }
}

// A Snaglet Console app or binary is development-only tooling and must never
// ship in the packaged desktop app. Tauri only bundles what the base
// config's bundle.externalBin (sidecar binaries), bundle.resources (copied
// files) and bundle.macOS.files declare, plus the sidecar dir we mirror below.
// This runs on every desktop build (the stage-desktop task), so a console
// sidecar/resource cannot be reintroduced without failing the build here.
function assertNoConsoleBundled(runtime) {
  const consolePattern = /console/i;
  const config = JSON.parse(readFileSync(path.join(tauriDirectory, 'tauri.conf.json'), 'utf8'));
  const bundle = config.bundle ?? {};
  const externalBin = Array.isArray(bundle.externalBin) ? bundle.externalBin.map(String) : [];
  const resources = bundle.resources ?? {};
  const resourcePaths = Array.isArray(resources)
    ? resources.map(String)
    : Object.entries(resources).flat().map(String);
  // bundle.macOS.files copies files straight into Contents/ (the reminder
  // notification sounds), so it is part of the shipped surface too.
  const macOSFiles = Object.entries(bundle.macOS?.files ?? {})
    .flat()
    .map(String);
  for (const declared of [...externalBin, ...resourcePaths, ...macOSFiles]) {
    if (consolePattern.test(declared))
      fail(
        `Snaglet Console must not be bundled — remove the console entry from tauri bundle config: ${declared}`
      );
  }
  // The sidecar dir is the realistic vector for shipping a stray app/binary; it
  // must contain only the pinned Node runtime we just copied.
  const stagedBinaries = readdirSync(tauriBinaries).sort();
  if (stagedBinaries.length !== 1 || stagedBinaries[0] !== runtime.executableName) {
    fail(
      `staged sidecar binaries must be exactly [${runtime.executableName}], found [${stagedBinaries.join(', ')}]`
    );
  }
}

function createManifest(runtime, postgres, ripgrep) {
  const files = walkFiles(stagedRoot).map((file) => ({
    path: path.relative(stagedRoot, file).split(path.sep).join('/'),
    sha256: sha256(file),
    size: statSync(file).size,
  }));
  const manifest = {
    files,
    node: {
      executable: `runtime/${runtime.executableName}`,
      sha256: runtime.sha256,
      triple: runtime.triple,
      version: nodeVersion,
    },
    postgres,
    profile: profileName,
    ripgrep,
    schemaVersion: 3,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  };
  writeFileSync(
    path.join(profileOutput, 'staging-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}

validateServerInput();
rmSync(stagedRoot, { recursive: true, force: true });
mkdirSync(stagedRoot, { recursive: true });
cpSync(serverInput, stagedServer, { recursive: true, preserveTimestamps: false });
stageCli();
if (production) {
  for (const file of walkFiles(stagedServer)) {
    if (file.endsWith('.map')) rmSync(file);
  }
}
signServerFsevents(stagedServer, {
  run: (command, args) => run(command, args, repositoryRoot),
});
const runtime = await stageNodeRuntime();
const ripgrep = await stageRipgrep();
const postgres = stagePostgresRuntime();
const windowsCrt = stageWindowsCrt([runtimeDirectory, path.join(stagedPostgres, 'bin')]);
const manifest = createManifest(runtime, postgres, ripgrep);

// Mirror the verified staging tree into the paths Tauri consumes. This script never compiles.
const tauriServer = path.join(tauriDirectory, 'resources', 'server');
const tauriCli = path.join(tauriDirectory, 'resources', 'cli');
const tauriPostgres = path.join(tauriDirectory, 'resources', 'pg');
const tauriRipgrep = path.join(tauriDirectory, 'resources', 'rg');
const tauriBinaries = path.join(tauriDirectory, 'binaries');
rmSync(tauriServer, { recursive: true, force: true });
rmSync(tauriCli, { recursive: true, force: true });
rmSync(tauriPostgres, { recursive: true, force: true });
rmSync(tauriRipgrep, { recursive: true, force: true });
rmSync(tauriBinaries, { recursive: true, force: true });
mkdirSync(path.dirname(tauriServer), { recursive: true });
mkdirSync(tauriBinaries, { recursive: true });
cpSync(stagedServer, tauriServer, { recursive: true, preserveTimestamps: false });
cpSync(stagedCli, tauriCli, { recursive: true, preserveTimestamps: false });
cpSync(stagedPostgres, tauriPostgres, { recursive: true, preserveTimestamps: false });
cpSync(path.join(stagedRoot, 'rg'), tauriRipgrep, { recursive: true, preserveTimestamps: false });
cpSync(
  path.join(runtimeDirectory, runtime.executableName),
  path.join(tauriBinaries, runtime.executableName)
);
assertNoConsoleBundled(runtime);
if (process.platform === 'win32') {
  const resources = {};
  for (const file of windowsCrt) {
    const relative = `resources/windows-crt/${file}`;
    const destination = path.join(tauriDirectory, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(runtimeDirectory, file), destination);
    resources[relative] = file;
  }
  writeFileSync(
    path.join(profileOutput, 'windows-bundle-config.json'),
    `${JSON.stringify({ bundle: { resources } }, null, 2)}\n`
  );
}

console.log(
  `[stage-sidecar] staged ${manifest.files.length} verified files (${manifest.totalBytes} bytes)`
);
console.log(`[stage-sidecar] manifest ${path.join(profileOutput, 'staging-manifest.json')}`);
