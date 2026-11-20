import { statSync } from 'node:fs';
import path from 'node:path';

/**
 * Codesign the staged server's fsevents.node (macOS only). It loads into the
 * hardened-runtime sidecar node, so it gets the same identity and options as
 * the PostgreSQL Mach-O files. Throws when the add-on is absent: without it
 * chokidar would fall back to a stat-polling watch mode. Dependencies are
 * injected for tests.
 */
export function signServerFsevents(
  serverRoot,
  {
    platform = process.platform,
    env = process.env,
    run,
    isFile = (file) => statSync(file, { throwIfNoEntry: false })?.isFile() === true,
  }
) {
  if (platform !== 'darwin') return null;
  const addon = path.join(serverRoot, 'node_modules', 'fsevents', 'fsevents.node');
  if (!isFile(addon)) {
    throw new Error(
      '[stage-sidecar] server bundle is missing node_modules/fsevents/fsevents.node (macOS file watching)'
    );
  }
  const identity = env.APPLE_SIGNING_IDENTITY?.trim() || '-';
  const args = ['--force', '--sign', identity, '--options', 'runtime'];
  if (identity === '-') args.push('--timestamp=none');
  args.push(addon);
  run('/usr/bin/codesign', args);
  run('/usr/bin/codesign', ['--verify', '--strict', addon]);
  return { addon, identity: identity === '-' ? 'adhoc' : identity };
}
