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

/**
 * Loose semver compare on dot-separated numeric parts ("v" prefix tolerated,
 * pre-release suffixes compared lexically only when numerics tie). Returns
 * >0 when a is newer than b.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const clean = v.trim().replace(/^v/i, '');
    const [core, pre] = clean.split('-', 2);
    const parts = core.split('.').map((p) => Number.parseInt(p, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return { parts, pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] - pb.parts[i];
  }
  // Same numeric core: a release (no pre tag) outranks a pre-release.
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}
