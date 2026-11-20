/**
 * doc_search — workspace_search scoped to docs.
 *
 * Thin wrapper: forces `kinds: ['doc']` and delegates to the workspace_search
 * handler so the lexical/semantic/hybrid logic, scoping, and access-control all
 * stay in one place. Docs are semantic-capable, so `mode: hybrid|semantic` work.
 */
import type { ToolHandler } from '@server/services/ToolService/types';
import workspaceSearch from './workspaceSearch/workspaceSearch';

const tool: ToolHandler = (input, settings, context) =>
  workspaceSearch({ ...input, kinds: ['doc'] }, settings, context);

export default tool;
