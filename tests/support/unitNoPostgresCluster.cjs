/**
 * Fail closed on real PostgreSQL provisioning in the unit projects.
 *
 * Mapping `pg` to the no-I/O pool stub stops a unit test from opening a
 * socket, but nothing stops one from constructing a PostgresRuntime and
 * initdb-ing (or source-building) a private cluster — minutes of wall clock
 * and hundreds of megabytes that leak when Jest kills the worker on timeout.
 * Pointing SNAGLET_PG_BINDIR at a directory that never exists makes
 * `ensurePostgresBinaries()` reject on the first executable it probes, and the
 * path itself states the rule. Suites whose subject is binary resolution clear
 * this variable in their own `beforeEach`.
 *
 * A package unit that genuinely needs a database belongs in
 * tests/integration/packages (project integration:db), where it gets a
 * per-file clone of the one shared cluster.
 */
'use strict';

const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.SNAGLET_PG_BINDIR = join(
  process.env.SNAGLET_HOME || tmpdir(),
  'no-postgres-cluster-in-unit-tests',
  'bin'
);
