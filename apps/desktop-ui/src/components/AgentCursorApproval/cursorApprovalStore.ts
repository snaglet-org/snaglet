import { useEffect, useSyncExternalStore } from 'react';
import type { CursorApprovalDecision } from '@snaglet/shared/constants/agentCursor';
import type { PendingRequest } from './requestReducer';

/**
 * Bridge between the always-mounted ws listener (AgentCursorApproval) and the
 * chat panes that render the approval as an InteractionPanel, the same UI the
 * `ask` tool uses. `hosts` counts mounted panes so the floating card can step
 * in only when no pane is there to show the prompt.
 */
export type CursorApprovalAnswer = (req: PendingRequest, decision: CursorApprovalDecision) => void;

interface State {
  requests: PendingRequest[];
  answer: CursorApprovalAnswer | null;
  hosts: number;
}

let state: State = { requests: [], answer: null, hosts: 0 };
const listeners = new Set<() => void>();

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Listener -> store: the current pending requests and how to answer one. */
export function publishCursorApprovals(
  requests: PendingRequest[],
  answer: CursorApprovalAnswer
): void {
  if (state.requests === requests && state.answer === answer) return;
  set({ requests, answer });
}

export function useCursorApprovalState(): State {
  return useSyncExternalStore(subscribe, () => state);
}

/** A chat pane calls this while mounted so the listener knows a panel is on screen. */
export function useCursorApprovalHost(): void {
  useEffect(() => {
    set({ hosts: state.hosts + 1 });
    return () => set({ hosts: Math.max(0, state.hosts - 1) });
  }, []);
}

/** Test helper. */
export function resetCursorApprovalStore(): void {
  state = { requests: [], answer: null, hosts: 0 };
  listeners.forEach((l) => l());
}
