/** Stop only the authenticated managed cluster recorded by this Jest run. */
'use strict';

const { execFileSync } = require('node:child_process');

module.exports = async function pgGlobalTeardown() {
  const handoffPath = process.env.SNAGLET_PG_TEST_HANDOFF_PATH;
  if (!handoffPath) throw new Error('Missing SNAGLET_PG_TEST_HANDOFF_PATH');
  // The helper validates the immutable handoff before touching a runtime and
  // uses production authenticated ownership checks. Failure preserves data.
  execFileSync(process.execPath, ['--import=tsx', 'tests/support/pgStopCluster.mts', handoffPath], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'inherit',
    windowsHide: true,
    timeout: 120_000,
  });
  delete process.env.SNAGLET_PG_TEST_HANDOFF_PATH;
  delete globalThis.__SNAGLET_PG_TEST_HANDOFF__;
};
