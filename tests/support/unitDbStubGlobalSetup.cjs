/** Create one isolated SNAGLET_HOME for the unit:server stub database run. */
'use strict';

const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * `generated/registry-source.static.ts` is a gitignored build artifact (the
 * bundle regenerates it) that two unit suites read to cross-check tool ids.
 * Regenerate it here (≈0.3s) so a fresh checkout's unit run does not depend
 * on a prior `build:server`.
 */
function regenerateToolRegistry() {
  execFileSync(
    process.execPath,
    [
      join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(REPO_ROOT, 'apps/server/src/services/ToolService/scripts/generate-tool-registry.ts'),
    ],
    { cwd: join(REPO_ROOT, 'apps', 'server'), stdio: 'ignore' }
  );
}

module.exports = async function unitDbStubGlobalSetup() {
  const stubHome = mkdtempSync(join(tmpdir(), 'snaglet-unit-db-stub-home-'));
  process.env.SNAGLET_UNIT_DB_STUB_HOME = stubHome;
  process.env.SNAGLET_HOME = stubHome;
  regenerateToolRegistry();
};
