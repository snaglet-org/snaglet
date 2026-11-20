import type { SidebarError } from '@snaglet/shared/types';

export const SIDEBAR_DISCLOSURE_EVENT = 'snaglet:sidebar-disclosure';
export interface SidebarDisclosureRequest {
  nodeId: string;
  expanded: boolean;
  reply: (result: { node_id: string; expanded: boolean } | { error: SidebarError }) => void;
}
/** Local typed request into WorkspaceTree; not a click, selection or navigation. */
export function requestSidebarDisclosure(
  panel: HTMLElement | null,
  nodeId: string,
  expanded: boolean
): Promise<{ node_id: string; expanded: boolean } | { error: SidebarError }> {
  const tree = panel?.querySelector<HTMLElement>('[data-sidebar-workspace]');
  if (!tree) return Promise.resolve({ error: 'node_unavailable' });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: 'node_unavailable' }), 2000);
    const reply: SidebarDisclosureRequest['reply'] = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    tree.dispatchEvent(
      new CustomEvent<SidebarDisclosureRequest>(SIDEBAR_DISCLOSURE_EVENT, {
        detail: { nodeId, expanded, reply },
      })
    );
  });
}
