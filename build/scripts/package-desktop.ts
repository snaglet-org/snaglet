import { execFileSync } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { resolveBuildProfile } from '../profiles';
import { desktopPreview } from '../profiles/desktop-preview';
import { desktopProduction } from '../profiles/desktop-production';
import { nsisExecutableSha256 } from './windows-executable';

const profileName = process.env.SNAGLET_BUILD_PROFILE;
if (profileName !== desktopPreview.name && profileName !== desktopProduction.name) {
  throw new Error(`Desktop packager received profile ${profileName ?? 'unset'}`);
}
const profile = resolveBuildProfile(profileName);
const production = profile.name === desktopProduction.name;
const arguments_ = process.argv.slice(2);
if (arguments_.some((argument) => argument !== '--bundle-only') || arguments_.length > 1) {
  throw new Error('Usage: package-desktop.ts [--bundle-only]');
}
const bundleOnly = arguments_.includes('--bundle-only');
const stagedManifest = path.resolve(profile.outputDirectory, 'staging-manifest.json');
if (!statSync(stagedManifest).isFile())
  throw new Error(`${profile.name} must be staged before packaging`);

const result = crossSpawn.sync(
  'pnpm',
  [
    '--filter',
    '@snaglet/desktop-shell',
    production ? 'build:production' : 'build:preview',
    ...(bundleOnly ? ['--bundle-only'] : []),
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, SNAGLET_BUILD_PROFILE: profile.name },
    stdio: 'inherit',
    windowsHide: true,
  }
);
if (result.error) throw new Error('Could not start desktop packaging', { cause: result.error });
if (result.status !== 0)
  throw new Error(
    `Tauri ${profile.name} packaging failed with status ${result.status ?? 'unknown'}`
  );

const release = path.resolve('apps/desktop/src-tauri/target/release');
const artifacts = path.resolve(profile.outputDirectory, 'artifacts');
const outputRoot = path.resolve('dist');
const artifactRelative = path.relative(outputRoot, artifacts);
if (
  !artifactRelative ||
  artifactRelative === '..' ||
  artifactRelative.startsWith(`..${path.sep}`) ||
  path.isAbsolute(artifactRelative)
) {
  throw new Error('Desktop artifacts must be inside the repository dist directory');
}
rmSync(artifacts, { force: true, recursive: true });
mkdirSync(artifacts, { recursive: true });
const installers: string[] = [];
let executable: string;
if (process.platform === 'darwin') {
  const appName = `${profile.productName}.app`;
  const destination = path.join(artifacts, appName);
  cpSync(path.join(release, 'bundle/macos', appName), destination, { recursive: true });
  // Seal resources before hashing. Ad-hoc hardened runtime would prevent the
  // bundled Node JIT from running without Developer ID entitlements.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', destination], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', destination], {
    stdio: 'inherit',
  });
  executable = path.join(destination, 'Contents/MacOS/desktop');
} else if (process.platform === 'win32' || process.platform === 'linux') {
  const windows = process.platform === 'win32';
  const destination = path.join(artifacts, 'app');
  const binaryDirectory = windows ? destination : path.join(destination, 'bin');
  // Tauri resolves Linux resources relative to bin/../lib/<productName>.
  const resourceDirectory = windows
    ? destination
    : path.join(destination, 'lib', profile.productName);
  mkdirSync(binaryDirectory, { recursive: true });
  mkdirSync(resourceDirectory, { recursive: true });
  executable = path.join(binaryDirectory, windows ? 'desktop.exe' : 'desktop');
  cpSync(path.join(release, path.basename(executable)), executable);
  cpSync(
    path.join(release, windows ? 'snaglet-node.exe' : 'snaglet-node'),
    path.join(binaryDirectory, windows ? 'snaglet-node.exe' : 'snaglet-node')
  );
  for (const resource of ['server', 'cli', 'pg', 'rg']) {
    cpSync(
      path.resolve(profile.outputDirectory, 'staged', resource),
      path.join(resourceDirectory, resource),
      { recursive: true }
    );
  }
  if (windows) {
    const runtime = path.resolve(profile.outputDirectory, 'staged', 'runtime');
    for (const dll of readdirSync(runtime).filter((file) => file.endsWith('.dll'))) {
      cpSync(path.join(runtime, dll), path.join(destination, dll));
    }
  }
  const bundleDir = path.join(release, 'bundle', windows ? 'nsis' : 'deb');
  const prefix = profile.productName.replaceAll(' ', '_').toLowerCase();
  for (const file of readdirSync(bundleDir)) {
    const normalized = file.replaceAll(' ', '_').toLowerCase();
    if (
      !normalized.startsWith(`${prefix}_`) ||
      !normalized.endsWith(windows ? '-setup.exe' : '.deb')
    )
      continue;
    cpSync(path.join(bundleDir, file), path.join(artifacts, file));
    installers.push(file);
  }
  if (installers.length === 0)
    throw new Error(`No ${profile.productName} installer found in ${bundleDir}`);
} else {
  throw new Error(`Unsupported desktop platform: ${process.platform}`);
}
const artifactFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? artifactFiles(absolute) : [absolute];
    });
const files = artifactFiles(artifacts).map((file) => ({
  path: path.relative(artifacts, file).split(path.sep).join('/'),
  sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  size: statSync(file).size,
}));
const sourceIdentifier = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
function toolVersion(command: string, cwd = process.cwd()): string {
  const result = crossSpawn.sync(command, ['--version'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Could not read ${command} version`, { cause: result.error });
  return result.stdout.trim();
}
// rustup resolves the toolchain per directory: the shell is pinned by
// apps/desktop/src-tauri/rust-toolchain.toml, so the Rust versions must be read
// from there or the manifest records the machine default instead of the
// compiler that actually built the executable.
const tauriProject = path.resolve('apps/desktop/src-tauri');
const toolVersions = {
  cargo: toolVersion('cargo', tauriProject),
  node: process.version,
  pnpm: toolVersion('pnpm'),
  rustc: toolVersion('rustc', tauriProject),
};
const executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
const manifest = {
  applicationId: profile.applicationId,
  executable: path.relative(artifacts, executable).split(path.sep).join('/'),
  executableSha256,
  executableSize: statSync(executable).size,
  files,
  installers,
  platform: `${process.platform}-${process.arch}`,
  minimumMacOSVersion: process.platform === 'darwin' ? profile.minimumMacOSVersion : null,
  nsisExecutableSha256:
    process.platform === 'win32' ? nsisExecutableSha256(readFileSync(executable)) : null,
  notarized: false,
  productName: profile.productName,
  profile: profile.name,
  releaseEligible: false,
  schemaVersion: 3,
  signed: false,
  signingRequired: profile.signing === 'required',
  sourceIdentifier,
  sourceMaps: profile.sourceMaps,
  toolVersions,
  totalBytes: files.reduce((total, file) => total + file.size, 0),
  updatesEnabled: profile.updatesEnabled,
};
writeFileSync(
  path.join(artifacts, 'artifact-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`
);
writeFileSync(
  path.join(artifacts, 'SHA256SUMS'),
  files.map((file) => `${file.sha256}  ${file.path}\n`).join('')
);
writeFileSync(
  path.join(artifacts, 'provenance.json'),
  `${JSON.stringify({ profile: profile.name, releaseEligible: false, sourceIdentifier, toolVersions }, null, 2)}\n`
);
console.log(`[${profile.name}] packaged ${artifacts}`);
