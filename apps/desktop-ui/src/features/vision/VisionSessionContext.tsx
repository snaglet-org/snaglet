import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  VisionCaptureRequestPayload,
  VisionCaptureResponsePayload,
  VisionPreviewFramePayload,
  VisionPreviewClearPayload,
  VisionSessionErrorPayload,
  VisionSessionSource,
  VisionSessionStatePayload,
  WsMessage,
} from '@snaglet/shared/types';
import { getApiUrl } from '@desktop/utils/api/core';
import { useWs } from '@desktop/ws/useWs';
import {
  captureStreamFrame,
  classifyMediaError,
  VisionCaptureClientError,
  type VisionCaptureSource,
} from './captureFrame';

export type VisionLocalStreams = Partial<Record<'screen' | 'camera', MediaStream>>;

function stopStreams(streams: VisionLocalStreams): void {
  for (const stream of Object.values(streams)) {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

class StaleVisionAcquisitionError extends Error {
  constructor() {
    super('Vision stream acquisition was superseded');
    this.name = 'StaleVisionAcquisitionError';
  }
}

async function acquireLocalStreams(
  source: VisionSessionSource,
  isCurrent: () => boolean,
  onAttempt?: (source: VisionCaptureSource) => void
): Promise<VisionLocalStreams> {
  const acquired: VisionLocalStreams = {};
  const assertCurrent = () => {
    if (!isCurrent()) throw new StaleVisionAcquisitionError();
  };
  try {
    assertCurrent();
    if (source === 'screen' || source === 'both') {
      onAttempt?.('screen');
      acquired.screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
      assertCurrent();
    }
    if (source === 'camera' || source === 'both') {
      onAttempt?.('camera');
      acquired.camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      assertCurrent();
    }
    return acquired;
  } catch (error) {
    stopStreams(acquired);
    throw error;
  }
}

interface VisionSessionContextValue {
  state: VisionSessionStatePayload;
  previewFrames: Partial<Record<VisionPreviewFramePayload['source'], VisionPreviewFramePayload>>;
  transientFrames: ReadonlyMap<string, VisionPreviewFramePayload>;
  localStreams: VisionLocalStreams;
  localPreviewError: string | null;
  error: string | null;
  start: (source: VisionSessionSource) => void;
  stop: () => void;
  clearError: () => void;
}

const VisionSessionContext = createContext<VisionSessionContextValue | null>(null);

function inactiveState(threadId: string): VisionSessionStatePayload {
  return {
    threadId,
    phase: 'inactive',
    enabled: false,
    source: null,
    sessionId: null,
    sessionDir: null,
    ready: false,
    error: null,
    updatedAt: new Date(0).toISOString(),
  };
}

export function VisionSessionProvider({
  threadId,
  children,
}: {
  threadId: string;
  children: ReactNode;
}) {
  const { send, addMessageListener, connectionState } = useWs();
  const [state, setState] = useState<VisionSessionStatePayload>(() => inactiveState(threadId));
  const [previewFrames, setPreviewFrames] = useState<
    Partial<Record<VisionPreviewFramePayload['source'], VisionPreviewFramePayload>>
  >({});
  const [transientFrames, setTransientFrames] = useState<
    ReadonlyMap<string, VisionPreviewFramePayload>
  >(() => new Map());
  const [localStreams, setLocalStreams] = useState<VisionLocalStreams>({});
  const [localPreviewError, setLocalPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const acquisitionTokenRef = useRef(0);

  const invalidatePendingAcquisition = useCallback(() => {
    acquisitionTokenRef.current += 1;
  }, []);

  useEffect(() => {
    invalidatePendingAcquisition();
    setState(inactiveState(threadId));
    setPreviewFrames({});
    setTransientFrames(new Map());
    setLocalStreams((current) => {
      stopStreams(current);
      return {};
    });
    setLocalPreviewError(null);
    setError(null);
  }, [invalidatePendingAcquisition, threadId]);

  useEffect(
    () => () => {
      invalidatePendingAcquisition();
      setLocalStreams((current) => {
        stopStreams(current);
        return {};
      });
    },
    [invalidatePendingAcquisition]
  );

  useEffect(
    () =>
      addMessageListener((message: WsMessage) => {
        if (message.type === 'vision:session:state') {
          const next = message.payload as VisionSessionStatePayload;
          if (next.threadId !== threadId || (message.channel && message.channel !== threadId)) {
            return;
          }
          if (!next.enabled || next.phase === 'inactive' || next.phase === 'stopping') {
            invalidatePendingAcquisition();
          }
          setState(next);
          setLocalStreams((current) => {
            if (!next.enabled || next.phase === 'inactive' || next.phase === 'stopping') {
              stopStreams(current);
              return {};
            }
            const keepScreen = next.source === 'screen' || next.source === 'both';
            const keepCamera = next.source === 'camera' || next.source === 'both';
            const updated: VisionLocalStreams = {
              ...(keepScreen ? { screen: current.screen } : {}),
              ...(keepCamera ? { camera: current.camera } : {}),
            };
            if (!keepScreen) current.screen?.getTracks().forEach((track) => track.stop());
            if (!keepCamera) current.camera?.getTracks().forEach((track) => track.stop());
            return updated;
          });
          setPreviewFrames((current) => {
            if (!next.sessionId || next.phase === 'starting' || next.phase === 'stopping')
              return {};
            return Object.fromEntries(
              Object.entries(current).filter(
                ([source, frame]) =>
                  frame.sessionId === next.sessionId &&
                  (next.source === 'both' || next.source === source)
              )
            );
          });
          setError(next.error);
          return;
        }
        if (message.type === 'vision:preview:frame') {
          const next = message.payload as VisionPreviewFramePayload;
          if (next.threadId !== threadId || (message.channel && message.channel !== threadId)) {
            return;
          }
          if (Date.parse(next.expiresAt) <= Date.now()) return;
          const frame = {
            ...next,
            deliveryUrl: getApiUrl(next.deliveryUrl.replace(/^\/api/, '')),
          };
          setPreviewFrames((current) => ({ ...current, [next.source]: frame }));
          setTransientFrames((current) => new Map(current).set(next.frameId, frame));
          return;
        }
        if (message.type === 'vision:preview:clear') {
          const next = message.payload as VisionPreviewClearPayload;
          if (next.threadId !== threadId || (message.channel && message.channel !== threadId)) {
            return;
          }
          setPreviewFrames((current) => {
            if (current[next.source]?.frameId !== next.frameId) return current;
            const updated = { ...current };
            delete updated[next.source];
            return updated;
          });
          setTransientFrames((current) => {
            if (!current.has(next.frameId)) return current;
            const updated = new Map(current);
            updated.delete(next.frameId);
            return updated;
          });
          return;
        }
        if (message.type === 'vision:session:error') {
          const next = message.payload as VisionSessionErrorPayload;
          if (next.threadId === threadId) setError(next.message);
          return;
        }
        if (message.type === 'vision:capture:request') {
          const request = message.payload as VisionCaptureRequestPayload;
          if (request.threadId !== threadId || (message.channel && message.channel !== threadId)) {
            return;
          }
          const stream = localStreams[request.source];
          void (async () => {
            const response: VisionCaptureResponsePayload = {
              threadId,
              requestId: request.requestId,
              source: request.source,
            };
            try {
              if (!stream) {
                throw new VisionCaptureClientError(
                  'stream_inactive',
                  `The browser-selected ${request.source} stream is unavailable.`
                );
              }
              Object.assign(response, await captureStreamFrame(stream, request.source));
            } catch (cause) {
              const classified = classifyMediaError(cause, request.source);
              response.error = classified.message;
              response.errorCode = classified.code;
            }
            send({ type: 'vision:capture:response', channel: threadId, payload: response });
          })();
        }
      }),
    [addMessageListener, invalidatePendingAcquisition, localStreams, send, threadId]
  );

  // ChatView owns the channel subscription. This explicit request gives a
  // direct-to-client snapshot after first connect and every reconnect, even
  // if the server emitted the last transition while this composer was closed.
  useEffect(() => {
    if (connectionState !== 'open') return;
    // Preview bytes are turn-scoped and are intentionally not hydrated. Drop
    // anything retained across a disconnect before asking for access state.
    setPreviewFrames({});
    setTransientFrames(new Map());
    send({ type: 'vision:session:status', channel: threadId, payload: { threadId } });
  }, [connectionState, send, threadId]);

  const start = useCallback(
    (source: VisionSessionSource) => {
      const token = acquisitionTokenRef.current + 1;
      acquisitionTokenRef.current = token;
      const isCurrent = () => acquisitionTokenRef.current === token;
      let attemptedSource: VisionCaptureSource = source === 'camera' ? 'camera' : 'screen';
      setError(null);
      setLocalPreviewError(null);
      void acquireLocalStreams(source, isCurrent, (attempting) => {
        attemptedSource = attempting;
      })
        .then((streams) => {
          if (!isCurrent()) {
            stopStreams(streams);
            return;
          }
          setLocalStreams((current) => {
            stopStreams(current);
            return streams;
          });
          send({ type: 'vision:session:start', channel: threadId, payload: { threadId, source } });
        })
        .catch((cause: unknown) => {
          if (cause instanceof StaleVisionAcquisitionError || !isCurrent()) {
            return;
          }
          const { message } = classifyMediaError(cause, attemptedSource);
          setLocalStreams((current) => {
            stopStreams(current);
            return {};
          });
          setLocalPreviewError(message);
          setError(message);
          send({ type: 'vision:session:stop', channel: threadId, payload: { threadId } });
        });
    },
    [send, threadId]
  );
  const stop = useCallback(() => {
    invalidatePendingAcquisition();
    setError(null);
    setLocalPreviewError(null);
    setLocalStreams((current) => {
      stopStreams(current);
      return {};
    });
    send({ type: 'vision:session:stop', channel: threadId, payload: { threadId } });
  }, [invalidatePendingAcquisition, send, threadId]);
  const clearError = useCallback(() => setError(null), []);

  const value = useMemo(
    () => ({
      state,
      previewFrames,
      transientFrames,
      localStreams,
      localPreviewError,
      error,
      start,
      stop,
      clearError,
    }),
    [
      state,
      previewFrames,
      transientFrames,
      localStreams,
      localPreviewError,
      error,
      start,
      stop,
      clearError,
    ]
  );
  return <VisionSessionContext.Provider value={value}>{children}</VisionSessionContext.Provider>;
}

export function useVisionSessionContext(): VisionSessionContextValue | null {
  return useContext(VisionSessionContext);
}
