import type { SidebarError } from '@snaglet/shared/types';

const targets = new WeakMap<HTMLElement, string>();
let nextTarget = 0;
const EVENT = 'snaglet:sidebar-mounted-disclosure';
interface Disclosure {
  expanded: boolean;
}
/** An opaque mount-scoped handle, deliberately unrelated to backend/group IDs. */
export function mountedTarget(row: HTMLElement, tab: string): string {
  let target = targets.get(row);
  if (!target) {
    target = JSON.stringify([tab, 'mounted', String(++nextTarget)]);
    targets.set(row, target);
  }
  return target;
}
/** Only disclosure setters belong here — never row clicks or enablement controls. */
export function mountedDisclosure(set: (expanded: boolean) => void) {
  return (element: HTMLElement | null) => {
    if (!element) return;
    const listener = (event: Event) => set((event as CustomEvent<Disclosure>).detail.expanded);
    element.addEventListener(EVENT, listener);
    return () => element.removeEventListener(EVENT, listener);
  };
}
/** The mounted row that inspect issued this handle for, or null. */
export function findMountedRow(
  panel: HTMLElement | null,
  tab: string,
  target: string
): HTMLElement | null {
  const row = Array.from(
    panel?.querySelectorAll<HTMLElement>('[data-sidebar-disclosure]') ?? []
  ).find((candidate) => targets.get(candidate) === target);
  return row && mountedTarget(row, tab) === target ? row : null;
}
export async function requestMountedDisclosure(
  panel: HTMLElement | null,
  tab: string,
  target: string,
  expanded: boolean
): Promise<{ expanded: boolean } | { error: SidebarError }> {
  const row = findMountedRow(panel, tab, target);
  if (!row) return { error: 'node_unavailable' };
  return new Promise((resolve) => {
    const finish = () => {
      if (!row.isConnected || !panel?.contains(row)) {
        cleanup();
        resolve({ error: 'node_unavailable' });
      } else if (row.getAttribute('aria-expanded') === String(expanded)) {
        cleanup();
        resolve({ expanded });
      }
    };
    const observer = new MutationObserver(finish);
    const timer = setTimeout(() => {
      cleanup();
      resolve({ error: 'node_unavailable' });
    }, 2000);
    const cleanup = () => {
      clearTimeout(timer);
      observer.disconnect();
    };
    observer.observe(panel!, { subtree: true, attributes: true, childList: true });
    // Always issue the idempotent setter: a preceding command may be queued
    // in React even when the DOM still matches this request.
    row.dispatchEvent(new CustomEvent<Disclosure>(EVENT, { detail: { expanded } }));
    finish();
  });
}
