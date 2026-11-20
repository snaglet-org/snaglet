import { useEffect, useReducer } from 'react';
import { useWs } from '@desktop/ws/useWs';
import {
  addRequest,
  extractRequestMessage,
  markExpired,
  pruneExpiredRequests,
  resolveRequest,
  type RequestList,
} from './requestReducer';
import type { AgentCursorRequestEvent } from '@snaglet/shared/constants/agentCursor';

export type RequestAction =
  | { type: 'add'; event: AgentCursorRequestEvent }
  | { type: 'resolve'; requestId: string }
  | { type: 'expired'; requestId: string }
  | { type: 'prune'; now: number };

function reducer(list: RequestList, a: RequestAction): RequestList {
  switch (a.type) {
    case 'add':
      return addRequest(list, a.event);
    case 'resolve':
      return resolveRequest(list, a.requestId);
    case 'expired':
      return markExpired(list, a.requestId);
    default:
      return pruneExpiredRequests(list, a.now);
  }
}

/** Subscribes to approval-request ws frames and keeps the pending list. */
export function useCursorRequests() {
  const [requests, dispatch] = useReducer(reducer, [] as RequestList);
  const { addMessageListener } = useWs();

  useEffect(
    () =>
      addMessageListener((message) => {
        const msg = extractRequestMessage(message);
        if (!msg) return;
        if (msg.kind === 'request') dispatch({ type: 'add', event: msg.event });
        else dispatch({ type: 'resolve', requestId: msg.event.requestId });
      }),
    [addMessageListener]
  );

  const has = requests.length > 0;
  useEffect(() => {
    if (!has) return;
    const t = window.setInterval(() => dispatch({ type: 'prune', now: Date.now() }), 500);
    return () => window.clearInterval(t);
  }, [has]);

  return { requests, dispatch };
}
