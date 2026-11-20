/**
 * Stage chokidar's macOS file-event add-on into the server bundle. macOS builds
 * must ship fsevents (the build fails without it); other platforms skip it and
 * chokidar uses fs.watch. `stagePackageTree` is injected (bundle.mjs / tests).
 */
export function stageFsevents({ platform = process.platform, stagePackageTree, log }) {
  if (platform !== 'darwin') {
    log('skipping fsevents (macOS-only)');
    return null;
  }
  log('staging fsevents (macOS file-event watching, native addon)…');
  const staged = stagePackageTree('fsevents');
  if (!staged.has('fsevents')) {
    throw new Error(
      `server bundle requires fsevents for macOS file watching (without it chokidar falls back to a polling watch mode); staged: ${[...staged].join(', ') || 'none'}`
    );
  }
  log(`staged fsevents closure: ${[...staged].join(', ')}`);
  return staged;
}
