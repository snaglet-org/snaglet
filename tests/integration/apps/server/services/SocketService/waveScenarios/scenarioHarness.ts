/**
 * Wave-scenario harness — spin a real thread with scripted agents and run the
 * real dispatch loop (wave loop + turn loop + provider call path) to
 * completion against the per-file PostgreSQL clone. The only fake is the
 * model: agents run on the `scripted` provider (providers/scripted.ts), so
 * every reply, mention, pass, tool call and delay is deterministic.
 *
 * Usage:
 *   const s = await createScenario({
 *     prefix: 'myfile',
 *     agents: [
 *       { key: 'alpha', script: [{ reply: 'hi @myfile-beta' }] },
 *       { key: 'beta', script: [{ reply: 'hello back' }] },
 *     ],
 *     dispatchMode: 'all',
 *   });
 *   const result = await s.send(`@${s.names.alpha} kick off`);
 *   ... assertions on result / s.events / s.assistantMessages() ...
 *   await s.cleanup();
 *
 * Every id/name is namespaced by `prefix` so files sharing a DB template
 * cannot collide. `cleanup()` removes all rows and resets the script store.
 */

import { afterAll, beforeAll, jest } from '@jest/globals';
import { getDb, Messages, Threads, Users } from '@snaglet/db';
import type { MessageRow } from '@snaglet/db/tables/messages';
import { Agents } from '@snaglet/db/tables/agents';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { wsService } from '@server/services/WebSocketService';
import {
  getScriptCalls,
  resetScriptedProvider,
  setScript,
  type ScriptedCallRecord,
  type ScriptedTurn,
} from '@server/services/ProviderChatService/providers/scripted';
import {
  dispatchToThread,
  type DispatchResult,
} from '@server/services/SocketService/dispatch/dispatchToThread';
import { generateId } from '@snaglet/shared/utils';
import { settingsService } from '@server/services/settings';
import { agentSettings } from '@server/services/settings/categories/agent';
import * as utilityText from '@server/services/summary/generateUtilityText';
import { summaryService } from '@server/services/SummaryService';
import {
  resetEmbeddingProvider,
  setEmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';

/**
 * Poll `condition` until it holds (or fail after `timeoutMs`). Use this instead
 * of a fixed sleep whenever a test must act at a specific point of a live run
 * (e.g. "while agent X's model call is in flight"): a fixed sleep races the
 * run's setup time, which varies with machine load and the per-run PG clone.
 */
export async function waitFor(
  condition: () => boolean,
  { timeoutMs = 10_000, intervalMs = 10, label = 'condition' } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Pin conversation compaction on for the calling suite, and restore it after.
 * `COMPACT_CONVERSATIONS` can come from a gitignored `.env`; with it off the
 * summary path never runs and the wave suites pass for the wrong reason. On is
 * the product default. Registered as lifecycle hooks so the change cannot leak
 * into another file sharing the worker process.
 */
export function pinConversationCompaction(): void {
  let previous: string | undefined;
  let generateSummary: ReturnType<typeof jest.spyOn<typeof utilityText, 'generateUtilityText'>>;

  beforeAll(() => {
    previous = process.env.COMPACT_CONVERSATIONS;
    process.env.COMPACT_CONVERSATIONS = 'true';
    // Fake only summary inference; retain real resolution, quality checks,
    // persisted summaries and replay compaction. No local model/network needed.
    generateSummary = jest
      .spyOn(utilityText, 'generateUtilityText')
      .mockResolvedValue(
        'The participants compared implementation options, recorded the tradeoffs, and continued discussing the next verification steps.'
      );
  });

  afterAll(() => {
    generateSummary.mockRestore();
    if (previous === undefined) delete process.env.COMPACT_CONVERSATIONS;
    else process.env.COMPACT_CONVERSATIONS = previous;
  });
}

/**
 * Make embeddings unavailable for the calling suite, and restore the real
 * provider after. Stagnation detection falls back to token-set Jaccard when it
 * cannot embed; with the real local embedder each failed attempt may first
 * read and checksum the ~137 MB model, which under load pushes multi-wave
 * scenarios past their timeout. A provider that always fails pins the Jaccard
 * path on every machine.
 */
export function pinEmbeddingsUnavailable(): void {
  const unavailable = (): Promise<number[]> =>
    Promise.reject(new Error('embeddings are unavailable in wave scenarios'));

  beforeAll(() => {
    setEmbeddingProvider({
      info: { provider: 'unavailable', model: 'unavailable', dimensions: 0 },
      embedDocument: unavailable,
      embedQuery: unavailable,
    });
  });

  afterAll(() => {
    resetEmbeddingProvider();
  });
}

export interface ScenarioAgentSpec {
  /** Short key; becomes the display name `${prefix}-${key}` (mention handle). */
  key: string;
  script: ScriptedTurn[];
  onExhausted?: 'pass' | 'repeat-last';
}

export interface ScenarioBudgetOverride {
  maxWaves?: number | null;
  maxTotalOutputTokens?: number;
}

export interface CreateScenarioOptions {
  /** Unique per test file — namespaces every id, name, and script id. */
  prefix: string;
  agents: ScenarioAgentSpec[];
  dispatchMode?: 'all' | 'mentioned';
  /** Written to threads.config_json.budget (thread-level overrides). */
  budget?: ScenarioBudgetOverride;
  /** threads.config_json.max_agent_dispatches (null = unlimited). */
  maxAgentDispatches?: number | null;
}

export interface CapturedEvent {
  channel: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface Scenario {
  threadId: string;
  userId: string;
  /** key → agent id */
  ids: Record<string, string>;
  /** key → display name (mention handle source) */
  names: Record<string, string>;
  /** Broadcasts captured from the real dispatch (socket:done, deltas, …). */
  events: CapturedEvent[];
  /** Persist a user message and run the real dispatch loop to completion. */
  send(message: string): Promise<DispatchResult>;
  /** Provider calls served for one agent key, in order. */
  callsFor(key: string): ScriptedCallRecord[];
  /** All persisted rows for the thread, oldest first. */
  allMessages(): Promise<MessageRow[]>;
  /** Assistant-authored rows only, oldest first. */
  assistantMessages(): Promise<MessageRow[]>;
  /**
   * Persisted `[conversation ended …]` thread-event broadcasts, in order.
   * Each carries the machine-readable `stop_reason` in its payload.
   */
  conversationEndedEvents(): CapturedEvent[];
  /** Remove all scenario rows + scripts + broadcast patch. */
  cleanup(): Promise<void>;
}

export async function createScenario(opts: CreateScenarioOptions): Promise<Scenario> {
  const { prefix } = opts;
  const threadId = `thread-${prefix}-${generateId('t')}`;
  const user = await Users.getOrCreateLocalUser();

  const ids: Record<string, string> = {};
  const names: Record<string, string> = {};

  for (const spec of opts.agents) {
    const agentId = `agent-${prefix}-${spec.key}`;
    const name = `${prefix}-${spec.key}`;
    const scriptId = `script-${prefix}-${spec.key}`;
    await Agents.create({
      id: agentId,
      name,
      providerId: 'scripted',
      modelId: scriptId,
      systemPrompt: 'Scripted scenario agent.',
      // No tools: keeps context assembly light and turns deterministic.
      toolAccessMode: 'allow_list',
      toolAccessAllowList: [],
    });
    setScript(scriptId, spec.script, { onExhausted: spec.onExhausted ?? 'pass' });
    ids[spec.key] = agentId;
    names[spec.key] = name;
  }

  // Explicit summary selection: scripted chat models are intentionally not
  // utility providers. Tests still execute the real summary policy/compactor.
  const summaryOverrides = await settingsService.read(agentSettings.summaryModelOverrides);
  await settingsService.write(agentSettings.summaryModelOverrides, {
    ...summaryOverrides,
    ...Object.fromEntries(
      Object.values(ids).map((id) => [id, { providerId: 'ollama', modelId: 'fixture-summary' }])
    ),
  });

  await Threads.create({
    id: threadId,
    title: `${prefix} scenario`,
    dispatchMode: opts.dispatchMode ?? 'all',
    ...(opts.maxAgentDispatches !== undefined
      ? { maxAgentDispatches: opts.maxAgentDispatches }
      : {}),
  });
  if (opts.budget) {
    // Typed columns. maxWaves uses the -1 sentinel for "genuinely
    // unbounded" so it stays distinguishable from an absent override; the
    // scenario API still speaks BudgetConfig's null.
    await Threads.updateSettings(threadId, {
      ...(opts.budget.maxWaves !== undefined
        ? { maxWaves: opts.budget.maxWaves === null ? -1 : opts.budget.maxWaves }
        : {}),
      ...(opts.budget.maxTotalOutputTokens !== undefined
        ? { maxTotalOutputTokens: opts.budget.maxTotalOutputTokens }
        : {}),
    });
  }
  for (const spec of opts.agents) {
    await ThreadParticipants.addParticipant({ threadId, agentId: ids[spec.key]! });
  }

  // Final replies also schedule summaries in the background. Drain those
  // before deleting fixture rows/settings, so cleanup cannot race inference.
  const summaryPasses = new Set<Promise<unknown>>();
  const originalGenerateSummary = summaryService.generateSummary.bind(summaryService);
  const summarySpy = jest.spyOn(summaryService, 'generateSummary').mockImplementation((input) => {
    const pass = originalGenerateSummary(input);
    summaryPasses.add(pass);
    void pass.then(
      () => summaryPasses.delete(pass),
      () => summaryPasses.delete(pass)
    );
    return pass;
  });

  // Capture every thread broadcast the real dispatch emits. The singleton has
  // no connected clients under jest, so the original call is a cheap no-op —
  // we record, then delegate.
  const events: CapturedEvent[] = [];
  const originalBroadcast = wsService.broadcastToChannel.bind(wsService);
  const patched: typeof wsService.broadcastToChannel = (channel, msg) => {
    if (channel === threadId && msg && typeof msg === 'object') {
      const m = msg as { type?: string; payload?: Record<string, unknown> };
      events.push({ channel, type: m.type ?? 'unknown', payload: m.payload ?? {} });
    }
    return originalBroadcast(channel, msg);
  };
  (wsService as { broadcastToChannel: typeof wsService.broadcastToChannel }).broadcastToChannel =
    patched;

  const send = async (message: string): Promise<DispatchResult> => {
    const messageId = generateId('message');
    await Messages.create({
      id: messageId,
      threadId,
      role: 'user',
      content: message,
      agentId: null,
      userId: user.id,
    });
    return dispatchToThread({
      threadId,
      senderId: user.id,
      messageId,
      message,
      source: 'tool',
    });
  };

  const cleanup = async (): Promise<void> => {
    while (summaryPasses.size) await Promise.allSettled([...summaryPasses]);
    summarySpy.mockRestore();
    (wsService as { broadcastToChannel: typeof wsService.broadcastToChannel }).broadcastToChannel =
      originalBroadcast;
    resetScriptedProvider();
    const summaryOverrides = await settingsService.read(agentSettings.summaryModelOverrides);
    for (const id of Object.values(ids)) delete summaryOverrides[id];
    await settingsService.write(agentSettings.summaryModelOverrides, summaryOverrides);
    const pool = getDb();
    await pool.query(`DELETE FROM runs WHERE thread_id = $1`, [threadId]);
    await pool.query(`DELETE FROM messages WHERE thread_id = $1`, [threadId]);
    await pool.query(`DELETE FROM thread_participants WHERE thread_id = $1`, [threadId]);
    await pool.query(`DELETE FROM threads WHERE id = $1`, [threadId]);
    await pool.query(`DELETE FROM nodes WHERE id = $1`, [threadId]);
    await pool.query(`DELETE FROM agents WHERE id LIKE $1`, [`agent-${prefix}-%`]);
  };

  return {
    threadId,
    userId: user.id,
    ids,
    names,
    events,
    send,
    callsFor: (key: string) => getScriptCalls(`script-${prefix}-${key}`),
    allMessages: () => Messages.listByThreadId(threadId),
    assistantMessages: async () =>
      (await Messages.listByThreadId(threadId)).filter((m) => m.role === 'assistant'),
    conversationEndedEvents: () =>
      events.filter(
        (e) =>
          e.type === 'socket:chat:message_created' &&
          e.payload['message_type'] === 'thread_event' &&
          typeof e.payload['content'] === 'string' &&
          (e.payload['content'] as string).startsWith('[conversation ended')
      ),
    cleanup,
  };
}
