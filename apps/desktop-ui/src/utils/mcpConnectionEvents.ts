export type McpConnectionEvent =
  | { type: 'client-renamed'; id: string; name: string }
  | { type: 'server-renamed'; id: string; name: string }
  | {
      /**
       * The MCP server set changed — created, removed, enabled/disabled, or
       * credential updated. Emitted by `useMcp` after every successful
       * mutation so surfaces holding their own copy of the server list
       * (`useMcpServers` behind AgentView's MCP section, the tool-access
       * option list) refetch while still mounted instead of waiting for a
       * remount that may never come.
       */
      type: 'servers-changed';
    };

const target = new EventTarget();
const EVENT_NAME = 'mcp-connection';

export function emitMcpConnectionEvent(event: McpConnectionEvent): void {
  target.dispatchEvent(new CustomEvent<McpConnectionEvent>(EVENT_NAME, { detail: event }));
}

export function onMcpConnectionEvent(handler: (event: McpConnectionEvent) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<McpConnectionEvent>).detail);
  target.addEventListener(EVENT_NAME, listener);
  return () => target.removeEventListener(EVENT_NAME, listener);
}
