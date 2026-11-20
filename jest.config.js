import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// Ensure NODE_ENV is 'test' for all projects — config.ts guards on this
// to skip .env loading and process.exit(1) in test mode.
process.env.NODE_ENV = 'test';

// Fail closed if a test project is missing its DB harness. Project setup
// replaces these with either a no-I/O Pool stub or a per-file PostgreSQL clone;
// no Jest process may fall through to the user's managed Snaglet home or live URL.
process.env.SNAGLET_DATABASE_URL =
  'postgresql://snaglet_unwired:snaglet_unwired@127.0.0.1:1/snaglet_unwired';
process.env.SNAGLET_HOME = join(tmpdir(), `snaglet-jest-unwired-${process.pid}`);
delete process.env.SNAGLET_PG_DATA_DIR;
delete process.env.DATABASE_URL;

// The runtime cache normally lives under SNAGLET_HOME, which the line above makes
// unique per run, so the integration cluster would compile PostgreSQL from
// source on every invocation. Pin the cache to the same place a normal Snaglet
// install builds it: version-pinned, manifest-validated executables, no user
// data.
process.env.SNAGLET_PG_RUNTIME_DIR ||= join(homedir(), '.snaglet', 'cache', 'postgres-runtime');

// Git worktrees under .snaglet/worktrees/ hold full copies of every package;
// without this, jest's module map sees duplicate package names and fails.
const agentWorktrees = ['<rootDir>/.snaglet/'];

/** @type {import('ts-jest').JestConfigWithTsJest} */

// @snaglet/theme maps to its TypeScript source: the committed index.js is an
// ES module ts-jest's CommonJS output cannot require, and the package's
// generated-files test pins index.js to that source.
const serverMapper = {
  'db-dirname': '<rootDir>/packages/db/db-dirname.cjs',
  // Native module that intermittently SIGABRTs jest workers at teardown —
  // stubbed everywhere; real inference runs in tsx child processes only.
  '^onnxruntime-node$': '<rootDir>/tests/support/onnxruntime-stub.cjs',
  // sherpa-onnx-node ships a ~75 MB native addon + needs models/audio — stub it
  // in jest; the voice engine's native path runs only via `voice:smoke`.
  '^sherpa-onnx-node$': '<rootDir>/tests/support/sherpa-onnx-stub.cjs',
  // ESM-only helper imported by apps/server/src/config.ts — ts-jest (CJS)
  // can't parse .mjs, so map to the CJS twin (db-dirname pattern).
  'dev-ports\\.mjs$': '<rootDir>/scripts/lib/dev-ports.cjs',
  '^(\\.{1,2}/.*)\\.js$': '$1',
  '^@snaglet/shared/types$': '<rootDir>/packages/shared/types/index.ts',
  '^@snaglet/shared/utils$': '<rootDir>/packages/shared/utils/index.ts',
  '^@snaglet/shared/(.*)$': '<rootDir>/packages/shared/$1',
  '^@snaglet/theme$': '<rootDir>/packages/theme/src/index.ts',
  '^@server/(.*)\\.js$': '<rootDir>/apps/server/src/$1',
  '^@server/(.*)$': '<rootDir>/apps/server/src/$1',
  '^@snaglet/db$': '<rootDir>/packages/db/index.ts',
  '^@snaglet/db/(.*)\\.js$': '<rootDir>/packages/db/$1',
  '^@snaglet/db/(.*)$': '<rootDir>/packages/db/$1',
};

// Custom transform: ts-jest + import.meta.url → __filename polyfill
const serverTransform = {
  '^.+\\.(ts|js)$': [
    '<rootDir>/tests/support/import-meta-transform.cjs',
    {
      useESM: true,
      tsconfig: 'apps/server/tsconfig.json',
    },
  ],
};

const sharedMapper = {
  'db-dirname': '<rootDir>/packages/db/db-dirname.cjs',
  '^onnxruntime-node$': '<rootDir>/tests/support/onnxruntime-stub.cjs',
  '^(\\.{1,2}/.*)\\.js$': '$1',
  '^@snaglet/shared/types$': '<rootDir>/packages/shared/types/index.ts',
  '^@snaglet/shared/utils$': '<rootDir>/packages/shared/utils/index.ts',
  '^@snaglet/shared/(.*)$': '<rootDir>/packages/shared/$1',
  '^@snaglet/theme$': '<rootDir>/packages/theme/src/index.ts',
  '^@snaglet/db$': '<rootDir>/packages/db/index.ts',
  '^@snaglet/db/(.*)$': '<rootDir>/packages/db/$1',
};

const sharedTransform = {
  '^.+\\.(ts|js)$': [
    '<rootDir>/tests/support/import-meta-transform.cjs',
    {
      useESM: true,
      // Match the packages' ES-module default-import semantics when the test
      // transformer lowers JSON/CommonJS imports to require().
      tsconfig: { esModuleInterop: true, allowSyntheticDefaultImports: true },
    },
  ],
};

// Package integration suites load the real @snaglet/db barrel, which reaches
// dotenv-expand's CommonJS default export. packages/tsconfig.json enables the
// interop that needs; the root config the shared transform picks up does not.
const dbTransform = {
  '^.+\\.(ts|js)$': [
    '<rootDir>/tests/support/import-meta-transform.cjs',
    {
      useESM: true,
      tsconfig: { esModuleInterop: true, allowSyntheticDefaultImports: true },
    },
  ],
};

export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testEnvironment: 'node',
  // Each ts-jest worker holds 600-900MB. Uncapped, jest spawns (cores - 1)
  // workers (9 on a 10-core machine, ~5GB) per run, and several runs can
  // overlap. `maxWorkers` is a global option -- the per-project values
  // below are ignored -- so cap it here. Override with SNAGLET_JEST_WORKERS=<n>.
  maxWorkers: Number(process.env.SNAGLET_JEST_WORKERS) || 3,
  // Coverage is opt-in (`pnpm test:coverage` or `--coverage`): collecting it on
  // every run roughly doubles time and memory and prints ~100x the output.
  collectCoverage: process.env.SNAGLET_COVERAGE === '1',
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  projects: [
    // Unit test projects
    {
      displayName: 'unit:server',
      modulePathIgnorePatterns: agentWorktrees,
      testMatch: ['<rootDir>/tests/unit/apps/server/**/*.test.{ts,js}'],
      testEnvironment: 'node',
      // Pure server units retain a no-I/O DB boundary. Mapping node-postgres
      // exercises the real external-mode facade and PostgresAdapter without
      // opening a socket; integration keeps the real `pg` implementation.
      moduleNameMapper: {
        '^pg$': '<rootDir>/tests/support/postgresPoolStub.cjs',
        ...serverMapper,
      },
      transform: serverTransform,
      globalSetup: '<rootDir>/tests/support/unitDbStubGlobalSetup.cjs',
      globalTeardown: '<rootDir>/tests/support/unitDbStubGlobalTeardown.cjs',
      setupFiles: [
        '<rootDir>/tests/support/unitDbStubEnv.cjs',
        '<rootDir>/tests/support/unitNoPostgresCluster.cjs',
        // supertest binds 127.0.0.1, not dual-stack `::`.
        '<rootDir>/tests/support/supertestLoopback.cjs',
        // unpdf's dynamic import() needs --experimental-vm-modules under Jest.
        '<rootDir>/tests/support/unpdfJestShim.cjs',
      ],
    },
    {
      displayName: 'unit:shared',
      modulePathIgnorePatterns: agentWorktrees,
      testMatch: [
        '<rootDir>/tests/unit/packages/**/*.test.{ts,js}',
        '<rootDir>/tests/unit/apps/desktop/**/*.test.{ts,js}',
      ],
      testEnvironment: 'node',
      // Same no-I/O DB boundary the server units keep: the real external-mode
      // facade and PostgresAdapter run against a mapped pool that never opens
      // a socket. A package unit that needs a real database belongs in
      // tests/integration/packages (project integration:db).
      moduleNameMapper: {
        '^pg$': '<rootDir>/tests/support/postgresPoolStub.cjs',
        ...sharedMapper,
      },
      transform: sharedTransform,
      setupFiles: ['<rootDir>/tests/support/unitNoPostgresCluster.cjs'],
    },

    // Integration test projects
    {
      displayName: 'integration:server',
      modulePathIgnorePatterns: agentWorktrees,
      testMatch: ['<rootDir>/tests/integration/apps/server/**/*.test.{ts,js}'],
      testEnvironment: 'node',
      maxWorkers: 4,
      moduleNameMapper: serverMapper,
      transform: serverTransform,
      // One managed cluster per Jest invocation; each file gets a fast clone
      // of the migrated, seeded template and drops only its exact database.
      globalSetup: '<rootDir>/tests/support/pgGlobalSetup.cjs',
      globalTeardown: '<rootDir>/tests/support/pgGlobalTeardown.cjs',
      setupFiles: [
        '<rootDir>/tests/support/pgPerFileSetup.cjs',
        // supertest binds 127.0.0.1, not dual-stack `::`.
        '<rootDir>/tests/support/supertestLoopback.cjs',
        // unpdf's dynamic import() needs --experimental-vm-modules under Jest.
        '<rootDir>/tests/support/unpdfJestShim.cjs',
      ],
      setupFilesAfterEnv: ['<rootDir>/tests/support/pgPerFileTeardown.ts'],
    },
    {
      displayName: 'integration:db',
      modulePathIgnorePatterns: agentWorktrees,
      testMatch: ['<rootDir>/tests/integration/packages/**/*.test.{ts,js}'],
      testEnvironment: 'node',
      maxWorkers: 4,
      moduleNameMapper: sharedMapper,
      transform: dbTransform,
      // Identical globalSetup path to integration:server on purpose: Jest keys
      // global hooks by module path, so both projects share the one cluster
      // this run starts, and each file still gets its own database.
      globalSetup: '<rootDir>/tests/support/pgGlobalSetup.cjs',
      globalTeardown: '<rootDir>/tests/support/pgGlobalTeardown.cjs',
      setupFiles: ['<rootDir>/tests/support/pgPerFileSetup.cjs'],
      setupFilesAfterEnv: ['<rootDir>/tests/support/pgPerFileTeardown.ts'],
    },
  ],
};
