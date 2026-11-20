import { useEffect, useRef } from 'react';
import type { SnagletAgent } from '@snaglet/shared/types';
import { agentsApi } from '@desktop/utils/api';
import { subscribeAgentEvents } from '@desktop/utils/agentEvents';
import { mapSelections, type LayoutNode } from '../layout/paneTree';

/** Ids of the agents shown by any pane or history entry. */
function shownAgentIds(layout: LayoutNode): Set<string> {
  const ids = new Set<string>();
  mapSelections(layout, (selection) => {
    if (selection?.kind === 'agent') ids.add(selection.agent.id);
    return selection;
  });
  return ids;
}

/**
 * Keep pane chrome and history titles aligned with agent renames. The title
 * reads the agent snapshot stored in the selection; a rename by an agent's
 * tool or another window (`agent.updated` naming `name`), or one missed while
 * the socket was down (`agents.invalidated`), rereads the agent and stores
 * the fresh snapshot in every pane and history entry showing it.
 */
export function useAgentSelectionSync(
  layout: LayoutNode,
  setLayout: React.Dispatch<React.SetStateAction<LayoutNode>>
): void {
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => {
    let active = true;
    const refresh = (agentId: string) => {
      agentsApi
        .get(agentId)
        .then((fresh: SnagletAgent) => {
          if (!active) return;
          setLayout((previous) =>
            mapSelections(previous, (selection) =>
              selection?.kind === 'agent' &&
              selection.agent.id === agentId &&
              selection.agent.name !== fresh.name
                ? { ...selection, agent: fresh }
                : selection
            )
          );
        })
        .catch((err: unknown) => {
          // A deleted agent's pane says so itself; nothing to rename.
          console.error('useAgentSelectionSync: failed to reread an agent', err);
        });
    };
    const stop = subscribeAgentEvents((event) => {
      const shown = shownAgentIds(layoutRef.current);
      if (event.type === 'agents.invalidated') {
        for (const id of shown) refresh(id);
        return;
      }
      if (event.changed.includes('name') && shown.has(event.agentId)) refresh(event.agentId);
    });
    return () => {
      active = false;
      stop();
    };
  }, [setLayout]);
}
