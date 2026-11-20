import { useSyncExternalStore } from 'react';
import {
  ASK_SETTLED,
  ASK_SNAPSHOT,
  type AskSettledPayload,
  type AskSnapshotPayload,
  type ClarificationRequestPayload,
  type ToolConfirmationRequestPayload,
} from '@snaglet/shared/types';

/**
 * Client mirror of the server's global ask feed: every Triage question and
 * tool-permission prompt still pending, whichever thread owns it. Fed by the
 * `asks` channel (see `ASK_EVENT_CHANNEL`); the popup stack reads it.
 */
export interface AskFeedState {
  clarifications: ClarificationRequestPayload[];
  confirmations: ToolConfirmationRequestPayload[];
}

const EMPTY: AskFeedState = { clarifications: [], confirmations: [] };

const upsert = <T extends { callId: string }>(list: T[], item: T): T[] => [
  ...list.filter((x) => x.callId !== item.callId),
  item,
];

/** Pure: fold one incoming frame into the state. Unknown frames return it unchanged. */
function applyAskFrame(
  state: AskFeedState,
  frame: { type?: string; payload?: unknown }
): AskFeedState {
  switch (frame.type) {
    case 'socket:clarification:request': {
      const p = frame.payload as ClarificationRequestPayload | undefined;
      if (!p?.callId) return state;
      return { ...state, clarifications: upsert(state.clarifications, p) };
    }
    case 'socket:tool:confirmation_request': {
      const p = frame.payload as ToolConfirmationRequestPayload | undefined;
      if (!p?.callId) return state;
      return { ...state, confirmations: upsert(state.confirmations, p) };
    }
    case ASK_SNAPSHOT: {
      const p = frame.payload as AskSnapshotPayload | undefined;
      return { clarifications: p?.clarifications ?? [], confirmations: p?.confirmations ?? [] };
    }
    case ASK_SETTLED: {
      const callId = (frame.payload as AskSettledPayload | undefined)?.callId;
      if (!callId) return state;
      return withoutCall(state, callId);
    }
    default:
      return state;
  }
}

/** Pure: drop a call locally (the user just answered it here). */
function withoutCall(state: AskFeedState, callId: string): AskFeedState {
  if (
    !state.clarifications.some((c) => c.callId === callId) &&
    !state.confirmations.some((c) => c.callId === callId)
  ) {
    return state;
  }
  return {
    clarifications: state.clarifications.filter((c) => c.callId !== callId),
    confirmations: state.confirmations.filter((c) => c.callId !== callId),
  };
}

let state: AskFeedState = EMPTY;
const listeners = new Set<() => void>();
const set = (next: AskFeedState): void => {
  if (next === state) return;
  state = next;
  listeners.forEach((fn) => fn());
};

export const applyFrameToFeed = (frame: { type?: string; payload?: unknown }): void =>
  set(applyAskFrame(state, frame));
export const dropFromFeed = (callId: string): void => set(withoutCall(state, callId));

export function useAskFeed(): AskFeedState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state
  );
}
