import { loadSnagletEnvironment } from '@snaglet/db/runtime/snaglet-env';

/** Repo model installers default to the same home as pnpm dev. Explicit
 * SNAGLET_ENV/SNAGLET_HOME and checkout env files retain the server's precedence. */
export function loadModelFetchEnvironment(startDir: string): void {
  if (!process.env.SNAGLET_ENV?.trim()) process.env.SNAGLET_ENV = 'dev';
  loadSnagletEnvironment(startDir);
}
