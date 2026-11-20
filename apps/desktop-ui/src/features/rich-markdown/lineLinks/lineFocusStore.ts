import { useSyncExternalStore } from 'react';
import type { DocAnchor } from '@snaglet/shared/utils';

/**
 * Pending "scroll to and highlight these lines" requests, by doc id. A line
 * link opened in a pane (from the preview modal's Open button) leaves one
 * here; the doc's DocView applies it once its editor has the content, then
 * consumes it. The nonce lets the same lines be requested twice.
 */
export interface LineFocusRequest {
  anchor: DocAnchor;
  nonce: number;
  /** Land the anchor's first line near the top and flash it, as an outline jump does. */
  jump?: boolean;
}

const pending = new Map<string, LineFocusRequest>();
const listeners = new Set<() => void>();
let counter = 0;

const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function requestDocLineFocus(
  docId: string,
  anchor: DocAnchor,
  options: { jump?: boolean } = {}
): void {
  pending.set(docId, { anchor, nonce: ++counter, ...(options.jump ? { jump: true } : {}) });
  notify();
}

/**
 * A chip in a doc that points into that same doc: a heading jumps there as
 * the outline does; lines are scrolled to and stay highlighted.
 */
export function requestInDocFocus(docId: string, anchor: DocAnchor): void {
  requestDocLineFocus(docId, anchor, { jump: 'heading' in anchor });
}

export function consumeDocLineFocus(docId: string, nonce: number): void {
  if (pending.get(docId)?.nonce !== nonce) return;
  pending.delete(docId);
  notify();
}

/** The pending request for `docId` (null to opt out). */
export function useDocLineFocusRequest(docId: string | null): LineFocusRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => (docId ? (pending.get(docId) ?? null) : null),
    () => null
  );
}
