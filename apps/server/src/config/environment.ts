/**
 * Loads env files and SNAGLET_ENV mode defaults into process.env.
 *
 * Delegates to the shared SNAGLET_ENV loader (packages/db/runtime/snaglet-env.ts), which
 * walks up from this module to the first directory holding an env file and
 * loads with per-key precedence: real process env > .env.local > .env.<mode>
 * (when SNAGLET_ENV selects dev|preview) > .env > mode defaults. Explicit process
 * env winning is required so launchers (test harnesses, the desktop shell
 * sidecar) can pass PORT/SNAGLET_HOME/etc. without the repo .env clobbering them,
 * and so mode defaults never override explicit configuration. Finding no env
 * file at all is fine — packaged deployments receive everything via process
 * env (the desktop shell passes each value explicitly), and the bundled server
 * (`SNAGLET_BUNDLED=1`) never looks for env files at all, so a Snaglet.app sitting under
 * the repository cannot inherit the checkout's `.env`.
 *
 * This runs as a side effect of the first import, and both the server entry
 * and the logger import it first: several modules (the logger's directory and
 * level among them) read configuration while they are being evaluated, and
 * must see SNAGLET_HOME / LOG_LEVEL from the env files, not the bare process env.
 * The loader's own messages are buffered because the logger does not exist
 * yet; the logger replays them once it is created.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { loadSnagletEnvironment } from '@snaglet/db/runtime/snaglet-env';

export interface EnvironmentLoadMessage {
  level: 'info' | 'warn';
  text: string;
}

export const environmentLoadMessages: EnvironmentLoadMessage[] = [];

if (process.env.NODE_ENV !== 'test') {
  loadSnagletEnvironment(path.dirname(fileURLToPath(import.meta.url)), {
    log: (text) => environmentLoadMessages.push({ level: 'info', text }),
    warn: (text) => environmentLoadMessages.push({ level: 'warn', text }),
  });
}
