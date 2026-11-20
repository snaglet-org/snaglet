/**
 * Prompt-eval runner: paired B/C trials on the task families, through the real
 * dispatch and turn loop (scenarioHarness). B is the shipped core prompt; C is
 * B with a candidate diff applied through the test-gated promptVariant seam.
 * Everything else (role text, tools, owner instructions, fixtures, user turns)
 * is identical; arms are interleaved in random order per repeat, and each trial
 * gets and cleans up fresh agents, thread and fixtures. Scripted mode (default)
 * replays the families' good/bad scripts to qualify the runner, not the prompt.
 * Live mode (SNAGLET_PROMPT_EVAL_LIVE=1 plus a credential from the DB store or
 * ANTHROPIC_API_KEY) runs a real model. Every trial writes a JSON transcript
 * (messages, tool calls, system-prompt sha256s, oracle result) under
 * SNAGLET_PROMPT_EVAL_OUT (default .snaglet/prompt-evals/<runId>/); the credential is
 * never written.
 */

import { createHash, randomInt } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { Agents } from '@snaglet/db/tables/agents';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { providerChatService } from '@server/services/ProviderChatService';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import { setScript } from '@server/services/ProviderChatService/providers/scripted';
import {
  setPromptVariant,
  type PromptVariant,
} from '@server/services/SystemPromptComposer/promptVariant';
import {
  createScenario,
  type Scenario,
} from '../../services/SocketService/waveScenarios/scenarioHarness';
import { FAMILIES, type OracleResult, type ScriptKind, type TaskFamily } from './families';

export type Arm = 'B' | 'C';
export type Mode = 'scripted' | 'live';

export interface LiveModel {
  providerId: string;
  modelId: string;
  credentialId?: string | null;
}

export interface TrialRecord {
  runId: string;
  family: TaskFamily['id'];
  arm: Arm;
  variantId: string;
  repeat: number;
  mode: Mode;
  script?: ScriptKind;
  model: string;
  /** sha256 of each system prompt the provider received, in call order. */
  systemHashes: string[];
  providerCalls: number;
  durationMs: number;
  oracle: OracleResult;
  /** Safe verified success: the primary outcome. */
  safeSuccess: boolean;
  error?: string;
  cleanupError?: string;
  transcript: Array<{ role: string; agent: string | null; content: string }>;
  toolCalls: Array<{ agent: string; tool: string | null; input: unknown; output: unknown }>;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Wrap providerChatService.complete for the trial so every call's system
 * prompt is hashed (proves B and C differ by exactly the variant, and that
 * each arm is byte-stable across its own turns). Returns an uninstall fn.
 */
function captureSystemPrompts(agentIds: Set<string>, into: string[]): () => void {
  const original = providerChatService.complete;
  providerChatService.complete = async (agent, messages, onChunk, options) => {
    if (agentIds.has(agent.id)) {
      const text = (options?.systemBlocks ?? []).map((b) => b.text).join('\n');
      into.push(sha(text));
    }
    return original.call(providerChatService, agent, messages, onChunk, options);
  };
  return () => {
    providerChatService.complete = original;
  };
}

export interface RunTrialOptions {
  runId: string;
  family: TaskFamily;
  arm: Arm;
  variant: PromptVariant;
  repeat: number;
  mode: Mode;
  script?: ScriptKind;
  live?: LiveModel;
  /** Per-trial wall clock ceiling for one dispatch. */
  timeoutMs?: number;
}

let toolsReady: Promise<void> | null = null;

/**
 * Load and sync the real tool registry once per process. Without it a tool
 * call resolves to nothing and a trial silently tests chat alone.
 */
export function ensureTools(): Promise<void> {
  toolsReady ??= (async () => {
    await toolRegistry.load();
    const sync = await toolRegistry.syncToDatabase();
    if (sync.errors.length > 0) throw new Error(`tool sync failed: ${JSON.stringify(sync.errors)}`);
  })();
  return toolsReady;
}

export async function runTrial(opts: RunTrialOptions): Promise<TrialRecord> {
  await ensureTools();
  const { family, arm, variant, mode } = opts;
  const prefix =
    `pe${opts.runId.slice(-5)}${family.id.slice(0, 3)}${arm}${opts.repeat}${opts.script?.replace(/[^a-z]/g, '').slice(0, 4) ?? ''}`
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const started = Date.now();
  const systemHashes: string[] = [];
  let scenario: Scenario | null = null;
  let fx: Record<string, string> = {};
  let uninstall = (): void => {};
  let oracle: OracleResult = { success: false, safe: true, notes: [] };
  let error: string | undefined;

  setPromptVariant(arm === 'C' ? variant : null);
  try {
    fx = await family.setup(prefix);
    scenario = await createScenario({
      prefix,
      dispatchMode: family.dispatchMode,
      // Scripts are installed below once names are known; start inert.
      agents: family.agents.map((a) => ({ key: a.key, script: [] })),
    });
    const s = scenario;
    for (const role of family.agents) {
      const agentId = s.ids[role.key]!;
      for (const tool of role.tools) {
        if (!toolRegistry.getHandler(tool)) throw new Error(`tool not loaded: ${tool}`);
      }
      await Agents.update(agentId, {
        role: role.role,
        toolAccessMode: 'allow_list',
        toolAccessAllowList: role.tools,
        ...(mode === 'live' && opts.live
          ? {
              providerId: opts.live.providerId,
              modelId: opts.live.modelId,
              credentialId: opts.live.credentialId ?? null,
            }
          : {}),
      });
      if (mode === 'scripted') {
        setScript(`script-${prefix}-${role.key}`, role.script(opts.script ?? 'good', fx, s.names));
      }
    }
    uninstall = captureSystemPrompts(new Set(Object.values(s.ids)), systemHashes);

    const turns = family.turns(fx, s.names);
    // When each user turn (session) started, so oracles can split tool calls by session.
    const sessionStarts: number[] = [];
    for (const [index, turn] of turns.entries()) {
      await family.beforeTurn?.(index, fx);
      sessionStarts.push(Date.now());
      await withTimeout(s.send(turn), opts.timeoutMs ?? 240_000, `${family.id} turn ${index}`);
    }

    oracle = await family.oracle(
      {
        ids: s.ids,
        names: s.names,
        threadId: s.threadId,
        assistantTexts: async () =>
          (await s.assistantMessages()).map((m) => ({ agentId: m.agentId, content: m.content })),
        toolCalls: async () =>
          (await AgentActivityLog.listThreadActivity({ threadId: s.threadId, limit: 300 }))
            .filter((row) => row.actionType === 'tool_call')
            .reverse()
            .map((row) => {
              const at = new Date(row.createdAt).getTime();
              const session = sessionStarts.filter((t) => t <= at).length - 1;
              return { tool: row.tool, input: row.toolInput, session: Math.max(0, session) };
            }),
      },
      fx
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    uninstall();
    setPromptVariant(null);
  }

  const transcript = scenario
    ? (await scenario.allMessages()).map((m) => ({
        role: m.role,
        agent: m.agentId,
        content: m.content,
      }))
    : [];
  const toolCalls = scenario
    ? (await AgentActivityLog.listThreadActivity({ threadId: scenario.threadId, limit: 500 }))
        .filter((row) => row.actionType === 'tool_call')
        .map((row) => ({
          agent: row.agentId,
          tool: row.tool,
          input: row.toolInput,
          output: row.toolOutput,
        }))
    : [];

  // Cleanup failure is recorded on its own: it says nothing about the agent,
  // so it never changes safeSuccess, but a leak must be visible.
  let cleanupError: string | undefined;
  try {
    if (scenario) await scenario.cleanup();
    await family.cleanup(fx);
  } catch (err) {
    cleanupError = err instanceof Error ? err.message : String(err);
  }

  return {
    runId: opts.runId,
    family: family.id,
    arm,
    variantId: arm === 'C' ? variant.id : 'B',
    repeat: opts.repeat,
    mode,
    ...(opts.script ? { script: opts.script } : {}),
    model:
      mode === 'live' && opts.live ? `${opts.live.providerId}/${opts.live.modelId}` : 'scripted',
    systemHashes,
    providerCalls: systemHashes.length,
    durationMs: Date.now() - started,
    oracle,
    safeSuccess: !error && oracle.success && oracle.safe,
    ...(error ? { error } : {}),
    ...(cleanupError ? { cleanupError } : {}),
    transcript,
    toolCalls,
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RunPairedOptions {
  runId: string;
  families: Array<TaskFamily['id']>;
  variant: PromptVariant;
  repeats: number;
  mode: Mode;
  live?: LiveModel;
  outDir: string;
  /** Deterministic arm order for tests; default random per repeat. */
  order?: (family: string, repeat: number) => [Arm, Arm];
}

export interface PairedSummary {
  runId: string;
  variantId: string;
  mode: Mode;
  model: string;
  rows: Array<{
    family: string;
    B: number;
    C: number;
    trials: number;
    /** Repeats where C's safe success < B's: any one blocks shipping. */
    worsePairs: number;
  }>;
  /** True only when no pair in any family is worse for C. */
  ship: boolean;
  outDir: string;
}

/** Paired B/C over each family × repeat, interleaved, transcripts to disk. */
export async function runPaired(opts: RunPairedOptions): Promise<PairedSummary> {
  await mkdir(opts.outDir, { recursive: true });
  const records: TrialRecord[] = [];
  for (const familyId of opts.families) {
    const family = FAMILIES[familyId];
    for (let repeat = 0; repeat < opts.repeats; repeat++) {
      const order =
        opts.order?.(familyId, repeat) ?? (randomInt(2) === 0 ? ['B', 'C'] : ['C', 'B']);
      for (const arm of order) {
        const record = await runTrial({
          runId: opts.runId,
          family,
          arm,
          variant: opts.variant,
          repeat,
          mode: opts.mode,
          ...(opts.mode === 'scripted' ? { script: 'good' as const } : {}),
          ...(opts.live ? { live: opts.live } : {}),
        });
        records.push(record);
        await writeFile(
          path.join(opts.outDir, `${familyId}.r${repeat}.${arm}.json`),
          JSON.stringify(record, null, 2)
        );
      }
    }
  }

  const rows = opts.families.map((family) => {
    const of = (arm: Arm) => records.filter((r) => r.family === family && r.arm === arm);
    let worsePairs = 0;
    for (let repeat = 0; repeat < opts.repeats; repeat++) {
      const b = of('B').find((r) => r.repeat === repeat)?.safeSuccess ? 1 : 0;
      const c = of('C').find((r) => r.repeat === repeat)?.safeSuccess ? 1 : 0;
      if (c < b) worsePairs++;
    }
    return {
      family,
      B: of('B').filter((r) => r.safeSuccess).length,
      C: of('C').filter((r) => r.safeSuccess).length,
      trials: opts.repeats,
      worsePairs,
    };
  });
  const summary: PairedSummary = {
    runId: opts.runId,
    variantId: opts.variant.id,
    mode: opts.mode,
    model: records[0]?.model ?? 'n/a',
    rows,
    ship: rows.every((r) => r.worsePairs === 0),
    outDir: opts.outDir,
  };
  await writeFile(path.join(opts.outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}
