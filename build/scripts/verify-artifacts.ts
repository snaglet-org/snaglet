import crossSpawn from 'cross-spawn';

import { resolveBuildProfile, type BuildProfileName } from '../profiles';

const profileArgument = process.argv.indexOf('--profile');
const profileName = process.argv[profileArgument + 1] as BuildProfileName | undefined;

if (profileArgument === -1 || !profileName) {
  throw new Error('Usage: pnpm verify:artifacts --profile <browser-preview|desktop-preview>');
}

resolveBuildProfile(profileName);

if (
  profileName !== 'browser-preview' &&
  process.platform !== 'darwin' &&
  process.platform !== 'win32'
) {
  throw new Error(`Desktop artifact verification is not implemented for ${process.platform}`);
}

const verifier =
  profileName === 'browser-preview'
    ? 'build/scripts/verify-browser-preview.ts'
    : process.platform === 'win32'
      ? 'build/scripts/verify-desktop-windows.ts'
      : profileName === 'desktop-preview'
        ? 'build/scripts/verify-desktop-preview.ts'
        : profileName === 'desktop-production'
          ? 'build/scripts/verify-desktop-production.ts'
          : undefined;

if (!verifier) {
  throw new Error(`Artifact verification is not implemented for profile ${profileName}`);
}

const result = crossSpawn.sync('tsx', [verifier], {
  cwd: process.cwd(),
  env: { ...process.env, SNAGLET_BUILD_PROFILE: profileName },
  stdio: 'inherit',
  windowsHide: true,
});

if (result.status !== 0) {
  throw new Error(
    `Artifact verification failed for ${profileName} with status ${result.status ?? 'unknown'}`
  );
}
