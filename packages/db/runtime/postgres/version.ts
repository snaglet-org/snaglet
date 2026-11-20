/** Single source of truth for the managed PostgreSQL runtime toolchain. */
export const POSTGRES_VERSION = '17.10' as const;
export const POSTGRES_MAJOR = 17 as const;
export const PGVECTOR_VERSION = '0.8.5' as const;
export const POSTGRES_MINIMUM_MACOS_VERSION = '14.0' as const;
export const POSTGRES_WINDOWS_MANIFEST_REVISION = 'utf8-v1' as const;

export const POSTGRES_SOURCE = {
  url: `https://ftp.postgresql.org/pub/source/v${POSTGRES_VERSION}/postgresql-${POSTGRES_VERSION}.tar.bz2`,
  sha256: '078a03516dcdbdb705fecaf415ea3d13a956c589e46f09fed68a06fb00598c90',
} as const;

/** EDB's Windows archive, linked by postgresql.org/download/windows for bundling. */
export const POSTGRES_WINDOWS_BINARY = {
  url: `https://get.enterprisedb.com/postgresql/postgresql-${POSTGRES_VERSION}-1-windows-x64-binaries.zip`,
  sha256: 'f9aafca58e7026a1ef2caeee711acf761671e57904d430adc85f468374f5a821',
} as const;

export const PGVECTOR_SOURCE = {
  url: `https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz`,
  sha256: '6f88a5cbdde31666f4b6c1a6b75c51dcbeffe58f9a7d2b26e502d5a6e5e14d44',
} as const;

export const POSTGRES_RUNTIME_ID = `${POSTGRES_VERSION}-pgvector-${PGVECTOR_VERSION}` as const;
