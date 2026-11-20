import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { LibraryTreeChild } from '@desktop/utils/api';
import {
  SIDEBAR_DISCLOSURE_EVENT,
  type SidebarDisclosureRequest,
} from '@desktop/ws/sidebarDisclosure';

/** Idempotent container-only state changes; replies only after a committed render. */
export function useSidebarDisclosure(args: {
  shellRef: RefObject<HTMLDivElement | null>;
  hideBody: boolean;
  nodeIndex: Map<string, LibraryTreeChild>;
  expanded: Set<string>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
}): void {
  const current = useRef(args);
  current.current = args;
  const [pending, setPending] = useState<SidebarDisclosureRequest[]>([]);
  useEffect(() => {
    const shell = args.shellRef.current;
    if (!shell) return;
    const handle = (event: Event) => {
      const request = (event as CustomEvent<SidebarDisclosureRequest>).detail;
      const { hideBody, nodeIndex, setExpanded } = current.current;
      if (hideBody) {
        request.reply({ error: 'wrong_tab' });
        return;
      }
      const node = nodeIndex.get(request.nodeId);
      const row = Array.from(shell.querySelectorAll<HTMLElement>('[data-row-id]')).find(
        (el) => el.dataset.rowId === request.nodeId
      );
      if (!node || !row) {
        request.reply({ error: 'node_unavailable' });
        return;
      }
      if (node.kind !== 'container') {
        request.reply({ error: 'not_container' });
        return;
      }
      setExpanded((prev) => {
        if (prev.has(request.nodeId) === request.expanded) return prev;
        const next = new Set(prev);
        if (request.expanded) next.add(request.nodeId);
        else next.delete(request.nodeId);
        return next;
      });
      // Separate state ensures even an already-expanded request gets a commit.
      setPending((requests) => [...requests, request]);
    };
    shell.addEventListener(SIDEBAR_DISCLOSURE_EVENT, handle);
    return () => shell.removeEventListener(SIDEBAR_DISCLOSURE_EVENT, handle);
  }, [args.shellRef]);
  useEffect(() => {
    if (!pending.length) return;
    for (const request of pending) {
      const expanded = args.expanded.has(request.nodeId);
      request.reply(
        expanded === request.expanded
          ? { node_id: request.nodeId, expanded }
          : { error: 'node_unavailable' }
      );
    }
    setPending([]);
  }, [pending, args.expanded]);
}
