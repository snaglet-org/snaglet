import { useEffect } from 'react';
import { onMcpConnectionEvent } from '@desktop/utils/mcpConnectionEvents';
import { mapSelections, type LayoutNode } from '../layout/paneTree';

/** Keep pane chrome and history titles aligned with connection renames. */
export function useMcpSelectionSync(
  setLayout: React.Dispatch<React.SetStateAction<LayoutNode>>
): void {
  useEffect(
    () =>
      onMcpConnectionEvent((event) => {
        setLayout((previous) =>
          mapSelections(previous, (selection) => {
            if (
              event.type === 'client-renamed' &&
              selection?.kind === 'mcp-client-connection' &&
              selection.client_id === event.id
            ) {
              return selection.name === event.name ? selection : { ...selection, name: event.name };
            }
            if (
              event.type === 'server-renamed' &&
              selection?.kind === 'mcp-server-connection' &&
              selection.server_id === event.id
            ) {
              return selection.name === event.name ? selection : { ...selection, name: event.name };
            }
            return selection;
          })
        );
      }),
    [setLayout]
  );
}
