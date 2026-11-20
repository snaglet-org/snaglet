/**
 * chatHelpers.ts — Small utility functions used by chat handlers.
 *
 * The implementations live in focused modules under `./chatHelpers/`; this
 * barrel re-exports them so callers keep one import path. Grouping:
 *   - agentStatusEvents  — agent typing/status WebSocket emitters
 *   - toolResultCondense — iteration-level tool-result retention (Tier 2/3)
 *   - messageClassification — message-type + stagnation heuristics
 *   - llmPayloadLog      — human-readable LLM payload logging
 *   - thinkingInterceptor — `<thinking>` tag streaming/strip helpers
 */

export { emitAgentTyping, emitAgentStatus } from './chatHelpers/agentStatusEvents';

export { condenseProcessedToolResults } from './chatHelpers/toolResultCondense';

export { resolveMessageType } from './chatHelpers/messageClassification';
export type { WaveTurnResult } from './chatHelpers/messageClassification';

export { logLlmPayload } from './chatHelpers/llmPayloadLog';

export { createThinkingInterceptor, stripThinkingTags } from './chatHelpers/thinkingInterceptor';
