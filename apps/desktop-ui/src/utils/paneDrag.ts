/**
 * MIME type for drag payloads that target a Dashboard pane. The payload
 * body is a JSON-serialized `DetailSelection` (`{kind:'doc'|'agent', …}`).
 *
 * Emitted by sidebar surfaces (WorkspaceTree, AgentsList, ContainerView)
 * and consumed by Pane drop zones + DocEditor chip-insertion.
 */
export const PANE_ITEM_MIME = 'application/x-snaglet-pane-item';
