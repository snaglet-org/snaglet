import { browserPreview } from './browser-preview';
import { desktopPreview } from './desktop-preview';
import { desktopProduction } from './desktop-production';
import { buildProfileSchema, type BuildProfile } from './schema';

const profiles = {
  'browser-preview': browserPreview,
  'desktop-preview': desktopPreview,
  'desktop-production': desktopProduction,
} as const;
export type BuildProfileName = keyof typeof profiles;

export function resolveBuildProfile(name: string): BuildProfile {
  const candidate = profiles[name as BuildProfileName];
  if (!candidate) throw new Error(`Unknown build profile: ${name}`);
  return buildProfileSchema.parse(candidate);
}

/**
 * Vite's `build.sourcemap` for a profile's source-map policy. A profile that
 * ships no maps must not generate them: staging deletes them anyway, and
 * generating them adds about 1 GB to the desktop UI build's heap.
 */
export function viteSourcemapOption(sourceMaps: BuildProfile['sourceMaps']): boolean | 'hidden' {
  if (sourceMaps === 'none') return false;
  return sourceMaps === 'hidden' ? 'hidden' : true;
}

export function printBuildProfile(profile: BuildProfile): void {
  console.log(`[build] profile ${JSON.stringify(profile, null, 2)}`);
}

export { buildProfileSchema } from './schema';
