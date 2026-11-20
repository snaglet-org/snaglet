/**
 * Route unit:server's real DB facade through a mapped, no-I/O PostgreSQL pool.
 * The fake URL is parsed by production configuration but never contacted.
 */
'use strict';

const stubHome = process.env.SNAGLET_UNIT_DB_STUB_HOME;
if (!stubHome) {
  throw new Error('unitDbStubEnv requires unitDbStubGlobalSetup to create SNAGLET_HOME first');
}

process.env.SNAGLET_HOME = stubHome;
// SNAGLET_DATABASE_URL alone selects the override path.
process.env.SNAGLET_DATABASE_URL =
  'postgresql://snaglet_unit_stub:snaglet_unit_stub@127.0.0.1:1/snaglet_unit_stub';

delete process.env.SNAGLET_PG_DATA_DIR;
delete process.env.SNAGLET_PG_BINDIR;
delete process.env.SNAGLET_PG_RUNTIME_DIR;
delete process.env.SNAGLET_PG_OWNED;
