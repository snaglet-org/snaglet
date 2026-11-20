/**
 * SystemPromptComposer types.
 *
 * The composer assembles the final system prompt for one agent's turn from
 * an ordered list of small block builders. Each builder is a pure async
 * function that takes a SystemPromptContext and either produces a content
 * block or skips (returns null) — e.g. threadSystemPromptBlock skips when the
 * thread has no user-authored system-prompt addendum.
 *
 * Adding a new block of system-prompt content is exactly:
 *   1. Add a file under ./blocks/<name>Block.ts implementing BlockBuilder.
 *   2. Insert it in the ordered list inside composeSystemPrompt.ts.
 * No other files need to change.
 */

import type { SnagletAgent } from '../AgentService';
import type { SkillCatalogEntry } from '../skills/skillCatalog';
import type { ResolvedAgentTool } from '../AgentToolResolver';
import type { MentionContext } from '../PerceptionService';
import type { ThreadRuntimeConfig, ThreadAgentRuntimeConfig } from '../ConfigResolverService';
import type { SystemContentBlock } from '../ProviderChatService';

export type { SystemContentBlock };

/**
 * Discriminator for which "wake mode" the agent is running in. Drives the
 * Run mode block of the system prompt (runModeBlock).
 *
 *  - realtime_thread — chat path.
 */
type RunKind = 'realtime_thread';

/**
 * Everything any block builder might need to do its job. Block builders
 * ignore the fields they don't use; the composer just passes the same
 * context object to every builder in order.
 */
export interface SystemPromptContext {
  /** The agent row as loaded from the DB. */
  agent: SnagletAgent;
  /** The agent + per-turn resolved provider/model overrides. */
  runtimeAgent: SnagletAgent;
  /** Per-thread override of this agent's config (systemPrompt, addendum, etc.). */
  threadAgentOverride?: ThreadAgentRuntimeConfig;

  /** The thread this turn belongs to. */
  threadId: string;
  /** Thread-level resolved runtime config (applies to every agent in this thread). */
  threadRuntimeConfig: ThreadRuntimeConfig | null;
  /** True when more than one human/agent participant is in the thread. */
  isGroup: boolean;
  /**
   * True for a DM / home thread (`threads.kind = 'dm'`). Fixed for a thread's
   * life, so prompt blocks may branch on it without busting the cache: no
   * routing modes, @-handoffs or group-thread guidance apply.
   */
  isDm?: boolean;
  /**
   * True for a subagent helper's own thread (`threads.parent_thread_id` set).
   * Fixed for a thread's life, so blocks may branch on it without busting the
   * cache. Nobody is added to, removed from or leaves a helper thread. No
   * block branches on it today: the helper variants key on the agent row
   * (isHelperRun).
   */
  isHelperThread?: boolean;

  /**
   * Thread-level dispatch routing mode (from threads.dispatch_mode).
   * 'all'         — every participating agent gets every message
   * 'mentioned'   — agents only get woken when explicitly @mentioned
   *
   * runModeBlock's realtime branch uses this to tell agents in `mentioned`
   * mode that they must @mention teammates to wake them mid-thread.
   */
  dispatchMode: 'all' | 'mentioned';

  /** Tool catalog this agent can see, with overrides already applied. */
  agentTools: ResolvedAgentTool[];

  /** All agent participants in this thread (used by runModeBlock to render the peer list in realtime mode). */
  participantAgentIds: ReadonlyArray<string>;
  /** The agent whose turn this is. Used to exclude self from the peers list. */
  replyAgentId: string;
  /** Mention parse for the triggering message (group only). */
  mentionContext?: MentionContext;

  /**
   * Soft-threshold telemetry shared across the wave loop. Read by
   * composeTurnContextData (the ephemeral turn-context tail) to inject the
   * "you've responded N times" note when an agent is over budget for the turn.
   * (It lives outside the system prompt — a per-turn note can't sit
   * in the byte-identical system prefix without busting the cache.)
   */
  agentSoftThresholdNotified: Set<string>;
  agentDispatchCount: Map<string, number>;

  //
  // Drives the Run mode slot. The chat path (runAgentTurn) always sets
  // runKind = 'realtime_thread'.

  /** Which wake mode this run is operating under. Required. */
  runKind: RunKind;

  /**
   * Free-form params surface for `<param: name/>` substitution inside
   * referenced docs. Populated by the caller from workspace orientation
   * results, thread metadata, etc. Empty record is valid (no substitutions
   * will fire).
   */
  runParams: Record<string, unknown>;

  /**
   * True when a real (non-mock) embedding provider is available.
   * Resolved once in composeSystemPrompt before the block loop runs —
   * callers never need to set this. Blocks use it to branch search
   * guidance between hybrid-mode and keyword-only instructions.
   */
  embeddingsEnabled?: boolean;

  /**
   * True while a voice session is active for this thread. Set by
   * contextAssembly from the voice registry. Drives the ephemeral voice profile
   * block in composeTurnContextData — BEHAVIOR only, never the system prefix, so
   * the cached system prompt stays byte-identical across a voice toggle.
   */
  voiceModeActive?: boolean;

  /**
   * This agent's effective skills for this thread, rendered by
   * skillCatalogBlock in the thread segment. Varies per thread (Inherit/Add/
   * Override), so it never feeds a CORE builder. Absent/empty → no block.
   */
  skillCatalog?: ReadonlyArray<SkillCatalogEntry>;
}

/**
 * Block builder contract. Pure async function: takes the full context,
 * returns one content block or null (skip). Builders never mutate
 * context. Order in the composer's list determines order in the prompt.
 */
export type BlockBuilder = (ctx: SystemPromptContext) => Promise<SystemContentBlock | null>;
