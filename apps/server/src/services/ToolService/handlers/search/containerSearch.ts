/**
 * container_search — workspace_search scoped to containers.
 *
 * Thin wrapper: forces `kinds: ['container']` and delegates to the
 * workspace_search handler. Containers are matched by case-insensitive
 * substring (keyword), so no semantic/hybrid mode is exposed.
 */
import type { ToolHandler } from '@server/services/ToolService/types';
import workspaceSearch from './workspaceSearch/workspaceSearch';

const tool: ToolHandler = (input, settings, context) =>
  workspaceSearch({ ...input, kinds: ['container'] }, settings, context);

export default tool;
