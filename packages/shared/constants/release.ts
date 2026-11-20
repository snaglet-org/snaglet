import release from './release.json' with { type: 'json' };

/**
 * GitHub `owner/repo` that holds Snaglet's source and publishes its releases.
 * release.json is the one place the organization and repository name live;
 * the updater endpoint in apps/desktop/src-tauri/tauri.conf.json must name the
 * same repository.
 */
export const SNAGLET_REPOSITORY = release.repository;
