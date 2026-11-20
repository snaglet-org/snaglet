import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { ThreadMessage } from '@desktop/utils/api';
import type {
  ClarificationRequestPayload,
  ToolConfirmationRequestPayload,
  WsMessage,
} from '@snaglet/shared/types';
import type { ToolCallCorrelation } from './useToolCallCorrelation';
import type { AgentStatus, MemoryExtractionNotice, RunActivity, StreamingMessage } from './types';

/**
 * The last unconfirmed send. Kept in a ref by `useChatStream` so a
 * send-stage rejection can restore the typed text and fire exactly one
 * silent retry. See `useChatStream` for the full lifecycle notes.
 */
export interface PendingSend {
  optimisticId: string;
  text: string;
  retriedOnce: boolean;
  /**
   * Set once the silent retry has replayed the send. A reconnect can deliver
   * more than one `session:created` before the replay is confirmed, and each
   * must not replay it again.
   */
  resent: boolean;
}

/**
 * Everything the per-frame WS handlers need from `useChatStream`'s scope:
 * the thread id, the WS send fn, the failed-send finalizer, the current
 * participant list, the tool-call correlation refs, the three mutable
 * refs, and every state setter the handlers coordinate.
 *
 * The object is rebuilt whenever `useChatStream`'s frame effect re-runs,
 * so each handler reads the values of the render that subscribed it. The
 * handlers are pure module functions: they close over nothing and receive
 * this context explicitly, which is what keeps the per-frame switch outside
 * the hook.
 */
export interface FrameHandlerCtx {
  threadId: string;
  send: (message: WsMessage) => void;
  failSend: (optimisticId: string, text: string, reason: string) => void;
  participantAgentIds: string[];
  correlation: ToolCallCorrelation;
  streamingRef: RefObject<Map<string, StreamingMessage>>;
  pendingSendRef: RefObject<PendingSend | null>;
  retryTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
  /**
   * Every session id the server has issued this pane for the current thread.
   * Direct (channel-less) frames reach every mounted chat, so an error is
   * attributed to this pane only when it names one of these sessions.
   */
  ownSessionIdsRef: RefObject<Set<string>>;
  setMessages: Dispatch<SetStateAction<ThreadMessage[]>>;
  setActivities: Dispatch<SetStateAction<Map<string, RunActivity>>>;
  setSessionId: Dispatch<SetStateAction<string | null>>;
  setStreaming: Dispatch<SetStateAction<Map<string, StreamingMessage>>>;
  setAgentStatuses: Dispatch<SetStateAction<Map<string, AgentStatus>>>;
  setOptimistic: Dispatch<SetStateAction<ThreadMessage[]>>;
  setPendingClarification: Dispatch<SetStateAction<ClarificationRequestPayload | null>>;
  setPendingToolConfirmations: Dispatch<SetStateAction<ToolConfirmationRequestPayload[]>>;
  setDispatchHint: Dispatch<SetStateAction<string | null>>;
  setMemoryExtractions: Dispatch<SetStateAction<MemoryExtractionNotice[]>>;
  setLastSendError: Dispatch<SetStateAction<{ text: string; message: string } | null>>;
  /**
   * Re-pull the whole transcript from the server. Only for frames that report
   * history the server has *deleted*, where no incremental edit can express the
   * new state. Pass a surviving message id to re-center on it.
   */
  reloadHistory: (focusMessageId?: string | null) => void;
  /**
   * Merge the latest persisted history into the view after frames may have
   * been missed (a new session following a reconnect or server restart), and
   * retire optimistic echoes the server turns out to have persisted.
   */
  resyncHistory: () => void;
}
