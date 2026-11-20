/**
 * Scripted provider — deterministic test-only chat "model".
 *
 * Purpose: behavioral scenario tests for the dispatch wave loop
 * (tests/integration/.../waveScenarios) and scripted demos on scratch
 * servers. Each agent whose `providerId` is `scripted` replays a per-script
 * sequence of turns (reply text, tool calls, delays) through the real turn
 * loop: context assembly, streaming seams, pass detection, mention routing
 * and budget accounting all run unmocked. This is deliberately a provider
 * registry entry (not a jest mock of runAgentTurn): the scenarios exist to
 * pin the orchestration code, so the orchestration code must actually run.
 *
 * Registration is gated: the entry is added to PROVIDER_REGISTRY only when
 * `NODE_ENV === 'test'` or `SNAGLET_ENABLE_SCRIPTED_PROVIDER=1` (see
 * `scriptedProviderEnabled()` + registry.ts). A production server never
 * exposes it.
 *
 * Script resolution order for `agent.modelId` (the script id):
 *   1. programmatic scripts installed via `setScript()` (jest harness path);
 *   2. a JSON file named by `SNAGLET_SCRIPTED_SCENARIOS_FILE`
 *      (`{ [scriptId]: ScriptedTurn[] }`) — the scratch-server demo path;
 *   3. no script found → the turn replies `[PASS]` (inert, converges fast).
 *
 * When a script runs out of turns, `onExhausted` decides: `'pass'` (default)
 * replies `[PASS]`; `'repeat-last'` replays the final turn forever (for
 * runaway/ping-pong scenarios that must outlive any cap under test).
 */

import { readFileSync } from 'fs';
import type { SnagletAgent } from '../../AgentService';
import type {
  OnChunkCallback,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderMessage,
} from '../types';

export interface ScriptedTurn {
  /** Visible reply text. May contain @mentions — they route for real. */
  reply?: string;
  /** Tool calls to request this turn (stopReason becomes 'tool_use'). */
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  /** Sleep before returning — wedge/reaper/timeout scenarios. Abort-aware. */
  delayMs?: number;
  /** Explicit usage override; defaults estimate ~1 token per 4 chars. */
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ScriptedCallRecord {
  scriptId: string;
  /** Index into the script, or -1 when the exhausted default fired. */
  turnIndex: number;
  /** Number of provider messages the call received (context size signal). */
  messageCount: number;
  /** True when the call ended via AbortSignal during a scripted delay. */
  aborted: boolean;
}

interface ScriptEntry {
  turns: ScriptedTurn[];
  cursor: number;
  onExhausted: 'pass' | 'repeat-last';
}

const scripts = new Map<string, ScriptEntry>();
const callLog: ScriptedCallRecord[] = [];
let scenarioFileLoaded = false;

/** True when the scripted provider may be registered/dispatched at all. */
export function scriptedProviderEnabled(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.SNAGLET_ENABLE_SCRIPTED_PROVIDER === '1';
}

/** Install (or replace) a script. `scriptId` is the agent's `modelId`. */
export function setScript(
  scriptId: string,
  turns: ScriptedTurn[],
  opts?: { onExhausted?: 'pass' | 'repeat-last' }
): void {
  scripts.set(scriptId, {
    turns: [...turns],
    cursor: 0,
    onExhausted: opts?.onExhausted ?? 'pass',
  });
}

/** Drop all scripts and the call log (per-test isolation). */
export function resetScriptedProvider(): void {
  scripts.clear();
  callLog.length = 0;
  scenarioFileLoaded = false;
}

/** Every chat call the provider served, in order. */
export function getScriptedCallLog(): readonly ScriptedCallRecord[] {
  return callLog;
}

/** Calls served for one script id, in order. */
export function getScriptCalls(scriptId: string): ScriptedCallRecord[] {
  return callLog.filter((c) => c.scriptId === scriptId);
}

function loadScenarioFileOnce(): void {
  if (scenarioFileLoaded) return;
  scenarioFileLoaded = true;
  const file = process.env.SNAGLET_SCRIPTED_SCENARIOS_FILE;
  if (!file) return;
  // Throw loudly on a malformed file — a scripted demo with a bad scenario
  // file should fail visibly, not silently degrade to all-[PASS] agents.
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, ScriptedTurn[]>;
  for (const [scriptId, turns] of Object.entries(parsed)) {
    if (!scripts.has(scriptId)) setScript(scriptId, turns);
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) throw new DOMException('scripted turn aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('scripted turn aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

let toolCallCounter = 0;

export async function chatScripted(
  agent: SnagletAgent,
  messages: ProviderMessage[],
  onChunk?: OnChunkCallback,
  options?: ProviderChatOptions
): Promise<ProviderChatResult> {
  if (!scriptedProviderEnabled()) {
    throw new Error('Scripted provider is disabled outside test environments');
  }
  loadScenarioFileOnce();

  const scriptId = agent.modelId ?? '';
  const entry = scripts.get(scriptId);

  let turn: ScriptedTurn;
  let turnIndex: number;
  if (!entry) {
    turn = { reply: '[PASS]' };
    turnIndex = -1;
  } else if (entry.cursor < entry.turns.length) {
    turnIndex = entry.cursor;
    turn = entry.turns[entry.cursor]!;
    entry.cursor += 1;
  } else if (entry.onExhausted === 'repeat-last' && entry.turns.length > 0) {
    turnIndex = entry.turns.length - 1;
    turn = entry.turns[turnIndex]!;
  } else {
    turn = { reply: '[PASS]' };
    turnIndex = -1;
  }

  const record: ScriptedCallRecord = {
    scriptId,
    turnIndex,
    messageCount: messages.length,
    aborted: false,
  };
  callLog.push(record);

  if (turn.delayMs && turn.delayMs > 0) {
    try {
      await abortableDelay(turn.delayMs, options?.signal);
    } catch (err) {
      record.aborted = true;
      throw err;
    }
  }

  const reply = turn.reply ?? '';
  if (reply && onChunk) onChunk(reply);

  const toolCalls = (turn.toolCalls ?? []).map((call) => ({
    id: `scripted-call-${++toolCallCounter}`,
    name: call.name,
    input: call.input,
  }));

  return {
    reply,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    usage: {
      inputTokens:
        turn.usage?.inputTokens ?? estimateTokens(messages.map((m) => JSON.stringify(m)).join('')),
      outputTokens: turn.usage?.outputTokens ?? estimateTokens(reply),
    },
  };
}
