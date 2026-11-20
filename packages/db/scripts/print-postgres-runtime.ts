import { ensurePostgresBinaries } from '../runtime/postgres/binaries';
import {
  PGVECTOR_SOURCE,
  PGVECTOR_VERSION,
  POSTGRES_MINIMUM_MACOS_VERSION,
  POSTGRES_RUNTIME_ID,
  POSTGRES_SOURCE,
  POSTGRES_VERSION,
  POSTGRES_WINDOWS_BINARY,
  POSTGRES_WINDOWS_MANIFEST_REVISION,
} from '../runtime/postgres/version';

const runtime = await ensurePostgresBinaries({ buildIfMissing: false });
if (process.argv.includes('--json')) {
  process.stdout.write(
    `${JSON.stringify({
      pgvectorVersion: PGVECTOR_VERSION,
      ...(process.platform === 'win32'
        ? {
            windowsBinarySha256: POSTGRES_WINDOWS_BINARY.sha256,
            windowsManifestRevision: POSTGRES_WINDOWS_MANIFEST_REVISION,
          }
        : {}),
      minimumMacOSVersion: process.platform === 'darwin' ? POSTGRES_MINIMUM_MACOS_VERSION : null,
      postgresVersion: POSTGRES_VERSION,
      rootDir: runtime.rootDir,
      runtimeId: POSTGRES_RUNTIME_ID,
      sourceSha256: {
        pgvector: PGVECTOR_SOURCE.sha256,
        postgres: POSTGRES_SOURCE.sha256,
      },
    })}\n`
  );
} else {
  process.stdout.write(`${runtime.rootDir}\n`);
}
