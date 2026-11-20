import { WorkspaceExecuteUnavailableError } from '@snaglet/db/tables/table_query';
import { getErrorMessage } from '@snaglet/shared/utils';
import { sqlState } from './errors';

/**
 * Explain a writer-pool refusal in terms of what the agent can change. The
 * `snaglet_workspace_writer` role is the boundary: PostgreSQL reports the denial
 * and this only says why, so the agent does not retry against system tables.
 */
export function describeWriterFailure(tool: string, error: unknown): string {
  const message = getErrorMessage(error);
  if (error instanceof WorkspaceExecuteUnavailableError) return message;
  switch (sqlState(error)) {
    case '42501':
      return (
        `${message}. ${tool} runs as the snaglet_workspace_writer role, which can reach only custom ` +
        'Database tables (the user_tables schema): Snaglet system tables such as agents, messages, ' +
        'memories, credentials and table_catalog are off limits, as are CREATE in public and ' +
        'server-side file, program and admin functions. Use database_query to read the workspace.'
      );
    case '42P01':
      return (
        `${message}. Unqualified names resolve in user_tables (custom Database tables); ` +
        'Snaglet system tables are not reachable from this tool.'
      );
    case '57014':
      return `${message}. Statements are canceled after 30 seconds; narrow the WHERE or batch the work.`;
    default:
      return message === 'Query read timeout'
        ? 'Statement canceled after 32 seconds; narrow the WHERE or batch the work.'
        : message;
  }
}
