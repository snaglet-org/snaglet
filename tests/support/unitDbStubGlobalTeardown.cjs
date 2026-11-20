/** Remove only the mkdtemp-owned SNAGLET_HOME created for this unit test run. */
'use strict';

const { realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname } = require('node:path');

module.exports = async function unitDbStubGlobalTeardown() {
  const stubHome = process.env.SNAGLET_UNIT_DB_STUB_HOME;
  if (!stubHome) return;

  try {
    const resolvedHome = realpathSync(stubHome);
    const resolvedTmp = realpathSync(tmpdir());
    if (
      dirname(resolvedHome) === resolvedTmp &&
      basename(resolvedHome).startsWith('snaglet-unit-db-stub-home-')
    ) {
      rmSync(resolvedHome, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup of an isolated test directory only.
  }
};
