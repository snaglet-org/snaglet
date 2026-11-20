/**
 * `agent` category settings: per-agent-turn knobs (turn timeout, stream idle
 * timeout, perception window), the agent-owned summary-model overrides (there
 * is no workspace-wide summary model), and `global_instructions`, rendered
 * into every agent's system prompt and written only through /api/settings.
 *
 * Settings keys must match /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/ (DB CHECK +
 * registry validation), so per-agent overrides cannot be per-row keys (agent
 * ids contain hyphens). Each lives in one map-valued setting keyed by id.
 */

import { z } from 'zod';
import { AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH } from '@snaglet/shared/constants';
import { defineCategory } from '../defineSetting';

const PositiveInt = z.number().int().positive();
/** 0 means "no limit" for the timeout settings below. */
const NonNegativeInt = z.number().int().nonnegative();

/** A provider+model pair naming the model that writes an agent's summaries. */
const SummaryModelRefSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  credentialId: z.string().min(1).nullable().optional(),
});

export type SummaryModelRef = z.infer<typeof SummaryModelRefSchema>;

const AgentSummaryModelsSchema = z.record(z.string(), SummaryModelRefSchema);

export type AgentSummaryModels = z.infer<typeof AgentSummaryModelsSchema>;

const ThreadAgentSummaryModelsSchema = z.record(
  z.string(),
  z.record(z.string(), SummaryModelRefSchema)
);

export type ThreadAgentSummaryModels = z.infer<typeof ThreadAgentSummaryModelsSchema>;

export const agentSettings = defineCategory('agent', {
  timeoutSeconds: {
    key: 'timeout_seconds',
    schema: NonNegativeInt,
    default: 0,
    description:
      'Wall-clock limit in seconds for a single agent turn. 0 = unlimited (default); ' +
      'stalled model calls are caught by stream_idle_timeout_seconds instead.',
  },
  streamIdleTimeoutSeconds: {
    key: 'stream_idle_timeout_seconds',
    schema: NonNegativeInt,
    default: 300,
    description:
      'Abort a model call when its provider stream has produced nothing for this many seconds ' +
      '(retried once, then the turn ends with a notice). 0 = off.',
  },
  perceptionMaxMessages: {
    key: 'perception_max_messages',
    schema: PositiveInt,
    // This is a runaway safety ceiling, not the
    // binding limit. The token budget (ContextWindowService) decides how
    // much history actually reaches the model; this only bounds the DB
    // fetch against pathological threads.
    default: 500,
    description:
      "Safety ceiling on thread messages fetched into an agent's perception slice per turn. " +
      'The token budget is the real limit — only lower this to bound DB reads on pathological threads.',
  },
  /**
   * Per-agent summary-model overrides — a map keyed by agent id. An entry
   * beats that agent's own effective model when writing its thread summaries.
   */
  summaryModelOverrides: {
    key: 'summary_model_overrides',
    schema: AgentSummaryModelsSchema,
    default: {} as AgentSummaryModels,
    description:
      'Per-agent summary-model overrides, keyed by agent id: ' +
      '{"agent-123":{"providerId":"ollama","modelId":"qwen2.5:3b"}}. An entry beats that ' +
      "agent's own effective model. Setting one is explicit consent to send summary " +
      'content to the named provider.',
  },
  /**
   * When true, step 3 of the summary-model chain (the agent's own chat model)
   * is disabled. Default false: otherwise a fresh install with no override
   * would halt the first thread that needs compaction. Step 3 is the same
   * model on the same provider, and every summary stamps `model_used`.
   */
  summaryModelRequireExplicit: {
    key: 'summary_model_require_explicit',
    schema: z.boolean(),
    default: false,
    description:
      "Require an explicit summary-model override. Default OFF: the agent's own chat model " +
      'writes its summaries when no override is set (same model, same provider, stamped in ' +
      'model_used). Turn it ON to require a deliberately named summarizer — an agent without ' +
      'one then cannot summarize, which stops the run and blocks the thread until one is set.',
  },
  /**
   * Per-thread-per-agent summary-model overrides — a nested map keyed by
   * thread id, then agent id. The highest-priority step in the chain.
   */
  threadSummaryModelOverrides: {
    key: 'thread_summary_model_overrides',
    schema: ThreadAgentSummaryModelsSchema,
    default: {} as ThreadAgentSummaryModels,
    description:
      'Per-thread-per-agent summary-model overrides, keyed by thread id then agent id: ' +
      '{"thread-1":{"agent-123":{"providerId":"ollama","modelId":"qwen2.5:3b"}}}. Beats the ' +
      'agent-level override in agent.summary_model_overrides for that agent in that thread.',
  },
  globalInstructions: {
    key: 'global_instructions',
    schema: z.string().max(AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH),
    default: '',
    description:
      "Instructions for all agents, added to every agent's system prompt in every thread " +
      '(the Instructions for all agents card on Home). Empty = none.',
  },
});
