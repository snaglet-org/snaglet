import crossSpawn from 'cross-spawn';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveBuildProfile, printBuildProfile, type BuildProfileName } from '../profiles';

export type BuildTask =
  | 'clean'
  | 'packages'
  | 'web'
  | 'server'
  | 'browser-preview'
  | 'stage-desktop'
  | 'package-desktop'
  | 'verify';

const dependencies: Record<BuildTask, readonly BuildTask[]> = {
  clean: [],
  packages: ['clean'],
  web: ['packages'],
  server: ['packages'],
  'browser-preview': ['web', 'server'],
  // Desktop packaging is a clean-source build. Keep `stage-desktop` itself as
  // the explicit prebuilt-input operation (used by stage verification), but a
  // public `package-desktop` target must first produce both the SPA and server
  // bundle rather than consuming whatever happens to be left in dist/.
  'stage-desktop': [],
  'package-desktop': ['web', 'server', 'stage-desktop'],
  verify: [],
};

const commands: Record<BuildTask, readonly string[]> = {
  clean: ['tsx', 'build/scripts/clean.ts'],
  packages: [
    'pnpm',
    '--filter',
    '@snaglet/shared',
    '--filter',
    '@snaglet/db',
    '--filter',
    '@snaglet/sdk',
    '--filter',
    '@snaglet/server',
    'run',
    'build',
  ],
  web: ['pnpm', '--filter', '@snaglet/desktop-ui', 'build'],
  server: ['pnpm', '--filter', '@snaglet/server', 'bundle'],
  'browser-preview': ['tsx', 'build/scripts/build-browser-preview.ts'],
  'stage-desktop': ['node', 'apps/desktop/scripts/stage-sidecar.mjs'],
  'package-desktop': ['tsx', 'build/scripts/package-desktop.ts'],
  verify: ['pnpm', 'run', 'test:build-profiles'],
};

export function taskPlan(target: BuildTask): BuildTask[] {
  const plan: BuildTask[] = [];
  const visit = (task: BuildTask): void => {
    for (const dependency of dependencies[task]) visit(dependency);
    if (!plan.includes(task)) plan.push(task);
  };
  visit(target);
  return plan;
}

export function runBuild(profileName: BuildProfileName, target: BuildTask, dryRun = false): void {
  const profile = resolveBuildProfile(profileName);
  printBuildProfile(profile);
  const plan = taskPlan(target);
  console.log(`[build] plan ${plan.join(' -> ')}`);
  if (dryRun) return;

  for (const task of plan) {
    const [command, ...args] = commands[task];
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      SNAGLET_BUILD_PROFILE: profile.name,
      SNAGLET_BUILD_OUTPUT: profile.outputDirectory,
    };
    if (process.platform === 'darwin' && profile.minimumMacOSVersion) {
      // Never let the build host's macOS version become the minimum version
      // encoded into native helpers and bundled PostgreSQL.
      environment.MACOSX_DEPLOYMENT_TARGET = profile.minimumMacOSVersion;
    }
    const result = crossSpawn.sync(command, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: environment,
      windowsHide: true,
    });
    if (result.error)
      throw new Error(`Build task ${task} could not start`, { cause: result.error });
    if (result.status !== 0)
      throw new Error(`Build task ${task} failed with status ${result.status ?? 'unknown'}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const profile = process.argv[2] as BuildProfileName | undefined;
  const target = process.argv[3] as BuildTask | undefined;
  const dryRun = process.argv.includes('--dry-run');
  if (!profile || !target || !(target in dependencies)) {
    throw new Error('Usage: tsx build/scripts/orchestrate.ts <profile> <task> [--dry-run]');
  }
  runBuild(profile, target, dryRun);
}
