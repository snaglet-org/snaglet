import { useCallback, useEffect, useMemo, useRef } from 'react';

interface ToolCallMeta {
  agentId: string;
  runId: string;
  toolName: string;
}

export interface ToolCallCorrelation {
  /** sessionId → agentId. Filled from delta / thinking / agent:status envelopes. */
  sessionAgent: React.RefObject<Map<string, string>>;
  /** agentId → latest runId. Filled from delta / thinking envelopes. */
  runByAgent: React.RefObject<Map<string, string>>;
  /** callId → metadata stashed at socket:tool:call edge, looked up at socket:tool:result. */
  callMeta: React.RefObject<Map<string, ToolCallMeta>>;
  /** Clear all three — call on threadId change. */
  reset: () => void;
}

/**
 * Reconstructs (agentId, runId) for tool-call envelopes that carry only
 * (sessionId, callId). The maps live in refs, not state: they are written on
 * every frame and never drive a render. They reset on threadId change.
 */
export function useToolCallCorrelation(threadId: string): ToolCallCorrelation {
  const sessionAgent = useRef<Map<string, string>>(new Map());
  const runByAgent = useRef<Map<string, string>>(new Map());
  const callMeta = useRef<Map<string, ToolCallMeta>>(new Map());

  // Stable across renders: reads only the (also stable) refs, so a single
  // identity is safe for the lifetime of the hook.
  const reset = useCallback(() => {
    sessionAgent.current.clear();
    runByAgent.current.clear();
    callMeta.current.clear();
  }, []);

  useEffect(() => {
    reset();
  }, [threadId, reset]);

  // The returned object must keep a stable identity: `useChatStream` lists
  // `correlation` in its frame-listener effect deps, so a fresh literal each
  // render would tear down and re-subscribe the WS listener on every render.
  // All four members are stable (three refs + a memoized callback), so this
  // memo only ever produces one object — behavior/values are unchanged.
  return useMemo(
    () => ({ sessionAgent, runByAgent, callMeta, reset }),
    [sessionAgent, runByAgent, callMeta, reset]
  );
}
