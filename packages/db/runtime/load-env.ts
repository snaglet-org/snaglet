import { dbDirname } from '../db-dirname';
import { loadSnagletEnvironment } from './snaglet-env';

/**
 * Load the checkout's env files into process.env.
 *
 * Delegates to the shared SNAGLET_ENV loader: precedence is real process env >
 * `.env.local` > `.env.<mode>` (when SNAGLET_ENV selects a mode) > `.env` > mode
 * defaults. With SNAGLET_ENV unset only the env files load, and the explicit
 * process environment always wins.
 */
export function loadEnvFile(): void {
  loadSnagletEnvironment(dbDirname);
}
