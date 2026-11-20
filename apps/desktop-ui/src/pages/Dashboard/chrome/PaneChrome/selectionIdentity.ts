import { workspaceNodeId, type DetailSelection } from '../../selection/types';

/**
 * Stable identity of what a pane shows: same item → same string, a different
 * item → a different string. Focus hints and hydrated caches are ignored, so
 * a re-seek or a node refresh is not a new item.
 */
export function selectionIdentity(selection: DetailSelection): string {
  if (!selection) return 'empty';
  const nodeId = workspaceNodeId(selection);
  if (nodeId) return `${selection.kind}:${nodeId}`;
  switch (selection.kind) {
    case 'agent':
      return `agent:${selection.agent.id}`;
    case 'file':
      return `file:${selection.node.id}`;
    case 'tool':
      return `tool:${selection.tool.id}`;
    case 'hook':
      return `hook:${selection.hook.hookName}`;
    case 'skill':
      return `skill:${selection.skill_id}:${selection.path}`;
    case 'automation-detail':
      return `automation-detail:${selection.automation_id}`;
    case 'table':
      return `table:${selection.table_id}`;
    case 'table-draft':
      return `table-draft:${selection.draft_id}`;
    case 'provider':
      return `provider:${selection.provider_id}`;
    case 'mcp-client-connection':
      return `mcp-client-connection:${selection.client_id}`;
    case 'mcp-server-connection':
      return `mcp-server-connection:${selection.server_id}`;
    case 'embeddings':
      return `embeddings:${selection.tab ?? 'embeddings'}`;
    default:
      return selection.kind;
  }
}
