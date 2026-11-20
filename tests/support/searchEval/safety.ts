const DATABASE_ENV = 'SNAGLET_PG_TEST_DATABASE';
const HOME_ENV = 'SNAGLET_PG_TEST_HOME';
const DATABASE_URL_ENV = 'SNAGLET_DATABASE_URL';

export type RealEmbeddingChildEnv = Record<string, string | undefined>;

function reject(reason: string): never {
  throw new Error(`Unsafe real embedding eval child environment: ${reason}`);
}

/**
 * Guard the real-embedding child before it imports any DB-backed module.
 * This intentionally accepts only the per-file disposable PostgreSQL contract.
 */
export function assertSafeRealEmbeddingChildEnv(env: RealEmbeddingChildEnv): void {
  if (env.CI !== undefined) reject('real embeddings are forbidden in CI');
  if (env.NODE_ENV !== 'test') reject('NODE_ENV must be test');
  if (env.SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS !== '1') {
    reject('SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS=1 is required');
  }

  const database = env[DATABASE_ENV];
  if (!database || !/^test_[a-z0-9_]+$/.test(database) || database.length > 63) {
    reject(`${DATABASE_ENV} must be a disposable test_* database name`);
  }

  const testHome = env[HOME_ENV];
  if (!testHome || env.SNAGLET_HOME !== testHome) {
    reject(`${HOME_ENV} and SNAGLET_HOME must both identify the same disposable home`);
  }

  const databaseUrl = env[DATABASE_URL_ENV];
  if (!databaseUrl) reject(`${DATABASE_URL_ENV} is required`);
  let parsed: URL;
  let urlDatabase: string;
  try {
    parsed = new URL(databaseUrl);
    urlDatabase = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    reject(`${DATABASE_URL_ENV} must be a valid PostgreSQL URL`);
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    reject(`${DATABASE_URL_ENV} must use the PostgreSQL scheme`);
  }
  if (urlDatabase !== database) {
    reject(`${DATABASE_URL_ENV} must target ${DATABASE_ENV}`);
  }
}
