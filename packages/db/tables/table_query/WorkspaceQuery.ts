/**
 * WorkspaceQuery — the sandbox `database_query` runs agent SQL in.
 *
 * Same engine as {@link TableQuery} (one SELECT, READ ONLY transaction,
 * SQL-side cell cut, row cap, cancellation), but on the `snaglet_workspace_reader`
 * pool, which can read the workspace except its secrets — see
 * `runtime/postgres/workspaceReader.ts` for the policy.
 */
import { getWorkspaceReaderClient } from '../../db';
import { TableQueryEngine } from './TableQuery';

export {
  hiddenWorkspaceObjects,
  WORKSPACE_READER_ROLE,
} from '../../runtime/postgres/workspaceReader';

export const WORKSPACE_QUERY_DEFAULT_LIMIT = 100;
export const WORKSPACE_QUERY_MAX_LIMIT = 500;
export const WORKSPACE_QUERY_DEFAULT_MAX_CELL = 100;
export const WORKSPACE_QUERY_MIN_MAX_CELL = 10;
export const WORKSPACE_QUERY_MAX_MAX_CELL = 20_000;

export const WORKSPACE_QUERY_UNAVAILABLE_MESSAGE =
  'database_query is unavailable on this database: there is no restricted reader connection ' +
  '(snaglet_workspace_reader), and agent SQL never runs as the app user. With SNAGLET_DATABASE_URL, ' +
  'set SNAGLET_WORKSPACE_READER_URL; with the managed database, the server log says why the role ' +
  'could not be provisioned.';

export const WorkspaceQuery = new TableQueryEngine({
  resolveReader: getWorkspaceReaderClient,
  unavailableMessage: WORKSPACE_QUERY_UNAVAILABLE_MESSAGE,
  limit: { fallback: WORKSPACE_QUERY_DEFAULT_LIMIT, max: WORKSPACE_QUERY_MAX_LIMIT },
  maxCell: {
    fallback: WORKSPACE_QUERY_DEFAULT_MAX_CELL,
    min: WORKSPACE_QUERY_MIN_MAX_CELL,
    max: WORKSPACE_QUERY_MAX_MAX_CELL,
  },
});
