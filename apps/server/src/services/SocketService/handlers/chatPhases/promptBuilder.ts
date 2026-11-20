import type { ToolRow } from '@snaglet/db/tables/tools';
import type { SnagletAgent } from '@server/services/AgentService';
import { compressMessages, type ContextBudget } from '@server/services/ContextWindowService';
import type {
  AssistantTurnBlock,
  ProviderChatResult,
  ProviderMessage,
  SystemContentBlock,
} from '@server/services/ProviderChatService/types';
import type { Message } from '@server/services/SocketService/types';
import { settingsService } from '@server/services/settings';
import { toolSettings } from '@server/services/settings/categories/tool';
import { condenseProcessedToolResults, logLlmPayload } from '../chatHelpers';
import type { RunCompactor } from './runCompactor';
import type { HistoryCompactor, HistoryCompactResult } from './historyCompactor';
import type { HistoryFoldState } from '@server/services/contextWindow/historyFold';

/**
 * Build the ordered content-block array for an assistant message that
 * requested tool use. A provider that returned the turn's own blocks (with
 * the thinking that must go back unchanged) is used as is; otherwise an
 * optional leading text block (the model's reply) followed by one tool_use
 * block per requested tool call.
 */
export function buildAssistantContentBlocks(result: ProviderChatResult): AssistantTurnBlock[] {
  if (result.assistantContent && result.assistantContent.length > 0) {
    return result.assistantContent;
  }
  const assistantContent: AssistantTurnBlock[] = [];

  if (result.reply) {
    assistantContent.push({ type: 'text', text: result.reply });
  }

  for (const tc of result.toolCalls ?? []) {
    assistantContent.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: tc.input,
    });
  }

  return assistantContent;
}

const isThinking = (block: { type: string }): boolean =>
  block.type === 'thinking' || block.type === 'redacted_thinking';

/**
 * The assistant turn a cut-off reply leaves in context before the model is
 * asked to continue: the provider's own blocks without tool calls (thinking
 * kept unchanged, so the model continues from its reasoning), else the text
 * exactly as it arrived. Empty when the reply has no text: a turn of thinking
 * alone is not sent back, and the model thinks afresh.
 */
export function buildCutOffTurnBlocks(result: ProviderChatResult): AssistantTurnBlock[] {
  if (!result.reply) return [];
  if (result.assistantContent && result.assistantContent.some((b) => b.type === 'text')) {
    return result.assistantContent.filter((block) => block.type !== 'tool_use');
  }
  return [{ type: 'text', text: result.reply }];
}

/** The same blocks without thinking. */
export function withoutThinkingBlocks(blocks: AssistantTurnBlock[]): AssistantTurnBlock[] {
  return blocks.filter((block) => !isThinking(block));
}

/**
 * Remove every thinking block from the run's messages, in place. Used once
 * the provider has refused replayed thinking, so later requests do not send
 * blocks it will refuse again.
 */
export function stripThinkingFromMessages(messages: Message[]): void {
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const blocks = message.content as Array<{ type: string }>;
    if (!blocks.some(isThinking)) continue;
    message.content = blocks.filter((block) => !isThinking(block)) as typeof message.content;
  }
}

export async function buildPromptMessagesForIteration({
  agent,
  runtimeAgent,
  agentMessages,
  budget,
  isGroup,
  threadName,
  threadId,
  systemBlocks,
  toolRows,
  iteration,
  compactionCarryForward,
  currentRunBoundary,
  runCompactor,
  historyCompactor,
  historyFold,
  onHistoryFolded,
}: {
  agent: SnagletAgent;
  runtimeAgent: SnagletAgent;
  agentMessages: Message[];
  budget: ContextBudget;
  isGroup: boolean;
  threadName: string;
  threadId: string;
  systemBlocks: SystemContentBlock[];
  toolRows: ToolRow[];
  iteration: number;
  /** Roster + dispatch-mode snapshot carried into the compaction summary. */
  compactionCarryForward: string;
  /**
   * Index into `agentMessages` where the current run's working state begins
   * (captured once per attempt by prepareModelAttemptContext). Everything
   * at/after it — the triggering message, the ephemeral tail, this run's own
   * tool exchanges — is uncompressible: compressMessages must never fold a
   * run's own working state into the summary mid-run.
   */
  currentRunBoundary: number;
  /**
   * Compacts the run itself when its own exchanges keep the payload over the
   * trigger after condensing and history compression. Omitted → no in-run
   * compaction (the payload is built exactly as without it).
   */
  runCompactor?: RunCompactor;
  /**
   * Folds the replayed history into a persisted compaction when compression would cut it.
   * Omitted (or without `historyFold`) → compressMessages' synthesized digest stands in, as it
   * did before compactions were persisted.
   */
  historyCompactor?: HistoryCompactor;
  /** The replay's unit spans and applied compaction; rewritten in place by a fold. */
  historyFold?: HistoryFoldState;
  /**
   * A fold removed messages from the front of `agentMessages` (`removed` net of the one summary
   * message that replaced them): everything the caller indexes into the list shifts by that.
   */
  onHistoryFolded?: (
    result: Extract<HistoryCompactResult, { kind: 'compacted' }>,
    removed: number
  ) => void;
}): Promise<ProviderMessage[]> {
  const condenseMinChars = await settingsService.read(toolSettings.condenseMinChars);
  const toolBulkBudget = await settingsService.read(toolSettings.toolBulkTokenBudget);
  // Two layers run in sequence (a third, in-run compaction, below). First,
  // the iteration-level condenser sheds
  // stale tool-result bulk: it dedups superseded re-reads (always) and, only
  // under real tool-bulk pressure, head+tails the oldest unique results. Then
  // the whole-history compressMessages folds old turns into a summary if the
  // full prompt still crosses the model-window threshold. Order matters —
  // shedding first often means compressMessages does not need to compact.
  // A history fold removes messages from the front of the list, which moves the boundary.
  let runBoundary = currentRunBoundary;
  const buildPayload = (): ReturnType<typeof compressMessages> => {
    const condensedMessages = condenseProcessedToolResults(agentMessages, {
      minChars: condenseMinChars,
      toolBulkBudget,
      provider: budget.provider,
      modelId: budget.modelId,
    });
    // When it trims, compressMessages injects the synthesized digest of the folded span as
    // message[0], carrying the current roster/mode forward (a persisted compaction, below,
    // replaces that digest with a model-written summary). `runBoundary` indexes
    // agentMessages, and stays valid against
    // condensedMessages because the condenser only rewrites tool_result content
    // in place — it never removes or reorders messages (see its module doc).
    // An in-run compaction only replaces messages after the run's head, so it
    // never moves the boundary either.
    return compressMessages(
      condensedMessages,
      budget,
      runtimeAgent.systemPrompt,
      // The thread digest is never context: a fold uses the persisted compaction, or the
      // synthesized digest of exactly the folded span.
      null,
      undefined,
      compactionCarryForward,
      undefined, // quiet: no — the live turn path logs compactions at info
      runBoundary
    );
  };

  let compression = buildPayload();
  // First layer that persists: when compression would fold history, summarize exactly the whole
  // units it would cut, save the cut, and rewrite the list the way replay will next turn.
  if (historyCompactor && historyFold && compression.compressed) {
    const messagesBefore = agentMessages.length;
    const result = await historyCompactor.compact({
      messages: agentMessages as ProviderMessage[],
      state: historyFold,
      splitIndex: compression.originalCount - compression.keptCount,
      budget,
      carryForward: compactionCarryForward,
    });
    if (result.kind === 'compacted') {
      const removed = messagesBefore - agentMessages.length;
      runBoundary -= removed;
      onHistoryFolded?.(result, removed);
      compression = buildPayload();
    }
  }
  // Third layer, only when the first two could not get under the trigger — so
  // what does not fit is the run's own exchanges: the run's oldest exchanges
  // fold into one summary message. It rewrites
  // `agentMessages` itself, so every later iteration starts from the
  // compacted run instead of paying for the fold again.
  if (runCompactor && compression.estimatedTokens > budget.tokenThreshold) {
    const outcome = await runCompactor.compact(agentMessages, budget, compression.estimatedTokens);
    if (outcome) {
      compression = buildPayload();
      await runCompactor.record(outcome, compression.estimatedTokens, budget);
    }
  }
  const { messages } = compression;

  logLlmPayload({
    agentName: agent.name,
    model: `${runtimeAgent.provider}/${runtimeAgent.modelId}`,
    threadName,
    threadId,
    systemBlocks,
    messages,
    tools: toolRows.map((t) => t.name),
    budget,
    iteration,
    isGroup,
  });

  return messages;
}
