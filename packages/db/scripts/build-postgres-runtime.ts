/**
 * Build Snaglet's pinned PostgreSQL + pgvector runtime from checksum-verified sources.
 *
 * Idempotent by default. `--force` parks and replaces an existing runtime;
 * `--archive` emits a tar.gz plus sha256 beside it. Failures are best-effort for
 * local setup unless `--strict` is supplied; runtime boot itself is always strict.
 */
import { getErrorMessage } from '@snaglet/shared/utils';
import { buildPostgresRuntime, postgresRuntimeRoot } from '../runtime/postgres/binaries';
import { POSTGRES_RUNTIME_ID } from '../runtime/postgres/version';

const flags = new Set(process.argv.slice(2));
const strict = flags.has('--strict');

async function main(): Promise<void> {
  const targetRoot = postgresRuntimeRoot();
  console.log(`[pg:runtime] ${POSTGRES_RUNTIME_ID}`);
  console.log(`[pg:runtime] target ${targetRoot}`);
  await buildPostgresRuntime({
    targetRoot,
    force: flags.has('--force'),
    archive: flags.has('--archive'),
  });
}

main().catch((error: unknown) => {
  console.error(`[pg:runtime] failed: ${getErrorMessage(error)}`);
  console.error(
    '  Install a C compiler, make, and tar, then retry: pnpm pg:runtime:build --strict'
  );
  process.exit(strict ? 1 : 0);
});
