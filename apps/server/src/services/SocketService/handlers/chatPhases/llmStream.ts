import type { ToolRow } from '@snaglet/db/tables/tools';
import type { SnagletAgent } from '@server/services/AgentService';
import { providerChatService } from '@server/services/ProviderChatService';
import type {
  OnUsageCallback,
  ProviderChatResult,
  ProviderMessage,
  SystemContentBlock,
} from '@server/services/ProviderChatService/types';
import { requestMaxOutputTokens, type ContextBudget } from '@server/services/ContextWindowService';
import { LogsService } from '@server/services/LogsService';
import { wsService } from '@server/services/WebSocketService';
import { createThinkingInterceptor, emitAgentStatus, emitAgentTyping } from '../chatHelpers';
import { createStreamIdleWatchdog } from './streamIdleWatchdog';

export interface StreamModelCallInput {
  readonly agent: SnagletAgent;
  readonly runtimeAgent: SnagletAgent;
  readonly messagesForAgent: ProviderMessage[];
  readonly toolRows: ToolRow[];
  readonly budget: ContextBudget;
  readonly systemBlocks: SystemContentBlock[];
  readonly abortController: AbortController;
  readonly sessionId: string;
  readonly clientId: string;
  readonly threadId: string;
  readonly threadName: string;
  readonly runId: string | null;
  readonly iteration: number;
  readonly latestThinking: string;
  readonly shouldStreamThinking: boolean;
  readonly previewMessage: (value: string, max?: number) => string;
  /**
   * Called with each visible (thinking-stripped) text chunk as it streams, so
   * the caller can accumulate the current iteration's spoken text and persist a
   * partial utterance if the run is aborted mid-sentence (barge-in).
   */
  readonly onVisibleDelta?: (chunk: string) => void;
  /**
   * Called with the in-flight call's usage as the provider reports it, so the
   * caller can drive a live token counter. Best-effort — the authoritative
   * per-call figure is `result.usage` on the resolved value.
   */
  readonly onUsage?: OnUsageCallback;
  /**
   * Abort this model call when its provider stream produces nothing for this
   * many ms (`agent.stream_idle_timeout_seconds`). 0 / undefined = off. A
   * stall throws `ProviderStreamStallError`; the turn's controller is not
   * aborted, so the caller may retry.
   */
  readonly streamIdleTimeoutMs?: number;
}

export interface StreamModelCallResult {
  readonly result: ProviderChatResult;
  readonly latestThinking: string;
  readonly emittedTyping: boolean;
}

export async function streamModelCall(input: StreamModelCallInput): Promise<StreamModelCallResult> {
  let latestThinking = input.latestThinking;
  let emittedTyping = false;
  const watchdog = createStreamIdleWatchdog(
    input.abortController.signal,
    input.streamIdleTimeoutMs ?? 0,
    input.runtimeAgent.provider
  );

  LogsService.thinking.start({
    agentName: input.agent.name,
    modelName: input.runtimeAgent.modelId,
    threadName: input.threadName,
    threadId: input.threadId,
    iteration: input.iteration,
    runId: input.runId,
    phase: 'model_decision',
  });

  const emitThinkingChunk = (chunk: string) => {
    watchdog.touch();
    latestThinking = `${latestThinking}${chunk}`.slice(-4000);
    // Chunk is already broadcast to the UI via the WS event below — no need
    // to also log every chunk. The thinking.end log (below) captures the
    // final preview once per turn.
    wsService.broadcastToChannel(input.threadId, {
      type: 'socket:thinking:chunk',
      payload: {
        sessionId: input.sessionId,
        runId: input.runId,
        text: chunk,
        agentId: input.agent.id,
      },
    });
  };

  try {
    const thinkingInterceptor = createThinkingInterceptor((text) => {
      if (!emittedTyping) {
        emittedTyping = true;
        emitAgentStatus(input.clientId, input.sessionId, input.agent.id, 'typing', {
          agentName: input.agent.name,
          threadId: input.threadId,
        });
        emitAgentTyping(input.clientId, input.sessionId, input.agent.id, true, {
          agentName: input.agent.name,
          threadId: input.threadId,
        });
      }
      input.onVisibleDelta?.(text);
      wsService.broadcastToChannel(input.threadId, {
        type: 'socket:delta',
        payload: {
          sessionId: input.sessionId,
          runId: input.runId,
          text,
          agentId: input.agent.id,
        },
      });
    }, emitThinkingChunk);

    const response = await providerChatService.complete(
      input.runtimeAgent,
      input.messagesForAgent,
      (chunk) => {
        watchdog.touch();
        thinkingInterceptor.push(chunk);
      },
      {
        ...(input.toolRows.length > 0 ? { tools: input.toolRows } : {}),
        // Every reply may use the model's full output length, solo or group.
        // The conversation's output pool only gates dispatching more turns.
        maxOutputTokens: requestMaxOutputTokens(input.budget),
        cacheTtl: input.budget.cacheTtl,
        systemBlocks: input.systemBlocks,
        signal: watchdog.signal,
        threadId: input.threadId,
        // Raw-read hook: fires on every network chunk, including tool-call
        // argument deltas that fire none of the other callbacks.
        onStreamActivity: watchdog.touch,
        onUsage: (usage) => {
          watchdog.touch();
          input.onUsage?.(usage);
        },
        ...(input.shouldStreamThinking ? { onThinkingChunk: emitThinkingChunk } : {}),
      }
    );

    thinkingInterceptor.flush();

    LogsService.thinking.end({
      agentName: input.agent.name,
      modelName: input.runtimeAgent.modelId,
      threadName: input.threadName,
      threadId: input.threadId,
      iteration: input.iteration,
      runId: input.runId,
      phase: 'model_decision',
      status: 'complete',
      stopReason: response.stopReason ?? 'unknown',
      toolCallCount: response.toolCalls?.length ?? 0,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      thinkingTokens: response.usage?.thinkingTokens ?? 0,
      thinking: input.previewMessage(response.thinkingContent ?? latestThinking, 220) || '',
    });

    return { result: response, latestThinking, emittedTyping };
  } catch (err) {
    LogsService.thinking.end({
      agentName: input.agent.name,
      modelName: input.runtimeAgent.modelId,
      threadName: input.threadName,
      threadId: input.threadId,
      iteration: input.iteration,
      runId: input.runId,
      phase: 'model_decision',
      status: 'error',
    });
    throw watchdog.translate(err);
  } finally {
    watchdog.dispose();
  }
}
