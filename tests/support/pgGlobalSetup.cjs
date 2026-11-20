/**
 * Start one isolated managed-PostgreSQL cluster and build the migrated template
 * database before Jest forks integration workers.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const { lstatSync, mkdtempSync, readFileSync, realpathSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');

const RUN_PREFIX = 'snaglet-pg-jest-';
const HANDOFF_ENV = 'SNAGLET_PG_TEST_HANDOFF_PATH';

function readAndValidateHandoff(handoffPath, expectedRunRoot) {
  const handoff = JSON.parse(readFileSync(handoffPath, 'utf8'));
  const runRoot = resolve(expectedRunRoot);
  if (handoff.schemaVersion !== 2) throw new Error('Unexpected PostgreSQL test handoff version');
  if (resolve(handoff.runRoot) !== runRoot) throw new Error('PostgreSQL test run-root mismatch');
  if (resolve(handoffPath) !== join(runRoot, 'handoff.json')) {
    throw new Error('PostgreSQL test handoff escaped its owned run root');
  }
  if (
    !basename(runRoot).startsWith(RUN_PREFIX) ||
    resolve(dirname(runRoot)) !== realpathSync(tmpdir())
  ) {
    throw new Error(`Refusing unexpected PostgreSQL test run root ${runRoot}`);
  }
  if (lstatSync(runRoot).isSymbolicLink()) {
    throw new Error(`Refusing symlinked PostgreSQL test run root ${runRoot}`);
  }
  // Windows bootstrap protects the handle before writing credentials. Node's
  // mode bits do not represent that DACL; retain the POSIX check elsewhere.
  if (process.platform !== 'win32' && (statSync(handoffPath).mode & 0o777) !== 0o600) {
    throw new Error('PostgreSQL test handoff permissions must be 0600');
  }
  if (handoff.templateDatabase !== 'snaglet_template') {
    throw new Error('Unexpected PostgreSQL test template database');
  }
  return handoff;
}

module.exports = async function pgGlobalSetup() {
  const runRoot = realpathSync(mkdtempSync(join(tmpdir(), RUN_PREFIX)));
  const handoffPath = join(runRoot, 'handoff.json');
  let bootstrapped = false;

  try {
    execFileSync(
      process.execPath,
      ['--import=tsx', 'tests/support/bootstrapPostgres.mts', runRoot, handoffPath],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'test' },
        timeout: 10 * 60 * 1000,
        windowsHide: true,
      }
    );
    readAndValidateHandoff(handoffPath, runRoot);
    bootstrapped = true;

    // globalSetup runs in Jest's parent process, so workers inherit this path.
    // Credentials remain only in the mode-0600 file rather than process.env.
    process.env[HANDOFF_ENV] = handoffPath;
    globalThis.__SNAGLET_PG_TEST_HANDOFF__ = handoffPath;
  } finally {
    if (!bootstrapped) {
      // Bootstrap attempts its own stop, but a subprocess timeout or stop
      // failure cannot prove the cluster died. Preserve its exact run root.
      console.error(`PostgreSQL bootstrap failed; retained disposable evidence at ${runRoot}`);
    }
  }
};
