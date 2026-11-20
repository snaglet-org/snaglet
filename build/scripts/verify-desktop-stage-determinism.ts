import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { desktopPreview } from '../profiles/desktop-preview';

const manifestPath = path.resolve(desktopPreview.outputDirectory, 'staging-manifest.json');
const first = readFileSync(manifestPath, 'utf8');
const result = spawnSync('node', ['apps/desktop/scripts/stage-sidecar.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SNAGLET_BUILD_OUTPUT: desktopPreview.outputDirectory,
    SNAGLET_BUILD_PROFILE: desktopPreview.name,
  },
  stdio: 'inherit',
});
if (result.status !== 0)
  throw new Error(`Second desktop staging pass failed with status ${result.status ?? 'unknown'}`);
const second = readFileSync(manifestPath, 'utf8');
if (first !== second) throw new Error('Repeated desktop staging produced a different manifest');
console.log('[desktop-stage] repeated staging manifest is deterministic');
