/**
 * Ask events — the global feed of agent asks (Triage questions and tool
 * permission prompts), for UI that is not tied to one chat pane.
 *
 * Every ask is announced on its thread's channel as before. It is also
 * mirrored here, so a client with no chat open for that thread can still show
 * the question (the "agent popups" surface) and answer it without a chat
 * session: responses carry the `threadId` instead of a `sessionId`.
 */
import type { ClarificationRequestPayload } from './clarification';
import type { ToolConfirmationRequestPayload } from './tool-confirmation';

/** Channel every ask frame is mirrored onto. Subscribe, then send ASK_SYNC. */
export const ASK_EVENT_CHANNEL = 'asks' as const;

/** client -> server: send me the full set of asks still pending. */
export const ASK_SYNC = 'asks:sync' as const;
/** server -> client: the full pending set; replaces whatever the client holds. */
export const ASK_SNAPSHOT = 'asks:snapshot' as const;
/** server -> client: an ask was answered, denied, timed out or aborted. */
export const ASK_SETTLED = 'asks:settled' as const;

export interface AskSnapshotPayload {
  clarifications: ClarificationRequestPayload[];
  confirmations: ToolConfirmationRequestPayload[];
}

export interface AskSettledPayload {
  callId: string;
}
