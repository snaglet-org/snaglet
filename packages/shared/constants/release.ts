import release from './release.json' with { type: 'json' };

/**
 * GitHub `owner/repo` that holds Snaglet's source and publishes its releases.
 * release.json is the one place the organization and repository name live;
 * the updater endpoint in apps/desktop/src-tauri/tauri.conf.json must name the
 * same repository.
 */
export const SNAGLET_REPOSITORY = release.repository;

/** Title of the notification that offers a newer release (`version` is its tag). */
export function appUpdateOfferTitle(version: string): string {
  return `Snaglet ${version} is available`;
}

/**
 * The release a notification offers, or null when it is not the update offer.
 * Other notices also use the `app_update` type (a project folder moved or went
 * missing), and clicking those must never offer an install.
 */
export function appUpdateOfferVersion(notification: {
  type: string;
  title: string;
}): string | null {
  if (notification.type !== 'app_update') return null;
  return /^Snaglet (\S+) is available$/.exec(notification.title)?.[1] ?? null;
}
