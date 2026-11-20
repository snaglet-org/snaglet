/**
 * composeSystemPrompt — the thread-constant system prompt. System is a strict
 * prefix of the prompt cache (tools → system → messages), so it carries only
 * content byte-identical every turn of a thread: the agent-level core
 * (CORE_BUILDERS), the workspace instructions, then the thread segment (skill
 * catalog, then the user's thread prompt last). Per-turn content goes in the
 * turn-context tail, roster/dispatch state in `thread_event` messages, the
 * summary in the compaction message. One of the four cache breakpoints is
 * placed here, on whichever block renders last.
 *
 * Order is cache layout (stable to volatile), not authority. The hierarchy:
 * the platform rules (the core blocks) bind every agent; the owner-written
 * instructions refine them (the agent's own "How you act" in identityBlock,
 * and the instructions for all agents, saved in Settings, which no agent tool
 * writes); thread instructions come last only because they vary per thread,
 * and their rendered frame makes them subordinate to platform and agent
 * instructions, since anyone with the `thread` tool, an agent included, can
 * write them. No frame ranks the two owner-written layers against each other.
 * User-authored text is never summarized or truncated here.
 */

import { identityBlock } from './blocks/identityBlock';
import { toolDiscoveryBlock } from './blocks/toolDiscoveryBlock';
import { goldenRulesBlock } from './blocks/goldenRulesBlock';
import { howToActBlock } from './blocks/howToActBlock';
import { perceptionBlock } from './blocks/perceptionBlock';
import { toolCatalogBlock, isSemanticSearchAvailable } from './blocks/toolCatalogBlock';
import { operatingContextBlock } from './blocks/operatingContextBlock';
import { runModeBlock } from './blocks/runModeBlock';
import { subagentBlock } from './blocks/subagentBlock';
import { workspaceInstructionsBlock } from './blocks/workspaceInstructionsBlock';
import { skillCatalogBlock } from './blocks/skillCatalogBlock';
import { threadSystemPromptBlock } from './blocks/threadSystemPromptBlock';
import { applyPromptVariant, getPromptVariant } from './promptVariant';
import type { BlockBuilder, SystemContentBlock, SystemPromptContext } from './types';

/** Extended (1h) TTL — chat turns; humans take breaks between messages. */
const CACHE_CONTROL = { type: 'ephemeral', ttl: '1h' } as const;

/**
 * The stable-core builders, in prompt order. All render thread-constant
 * content — none branch on thread-variable state (roster, dispatch mode,
 * per-turn data). The tool-discovery rule comes right after identity, before
 * the long how-to-work material, so it is not skimmed (toolDiscoveryBlock).
 */
const CORE_BUILDERS: BlockBuilder[] = [
  identityBlock,
  toolDiscoveryBlock,
  operatingContextBlock,
  goldenRulesBlock,
  howToActBlock,
  perceptionBlock,
  runModeBlock,
  subagentBlock,
  toolCatalogBlock,
];

/**
 * Assemble the final system blocks for one agent's turn (constant core +
 * the owner's instructions for all agents + user-authored thread system
 * prompt). Per-turn content goes in composeTurnContextTail instead.
 *
 * Builders run sequentially because order defines cache-breakpoint placement.
 */
export async function composeSystemPrompt(ctx: SystemPromptContext): Promise<SystemContentBlock[]> {
  // Resolve once so every block sees the same value. embeddingsEnabled is
  // rendered into core system-prompt bytes, so a flap would bust the cached
  // prefix; isSemanticSearchAvailable latches last-true per process to keep it
  // stable.
  ctx.embeddingsEnabled = await isSemanticSearchAvailable();

  const core: SystemContentBlock[] = [];
  for (const build of CORE_BUILDERS) {
    const block = await build(ctx);
    if (block !== null) core.push(block);
  }

  // Workspace segment: the owner's instructions for all agents, after the
  // agent-level core and before anything per-thread.
  const blocks = [...core];
  const workspaceInstructions = await workspaceInstructionsBlock(ctx);
  if (workspaceInstructions !== null) blocks.push(workspaceInstructions);

  // Thread segment: per-thread content. The skill catalog first, then the
  // thread's instructions last: the most volatile segment, not the final word
  // (their frame makes them subordinate; see the header).
  const skillCatalog = await skillCatalogBlock(ctx);
  if (skillCatalog !== null) blocks.push(skillCatalog);
  const threadSystemPrompt = await threadSystemPromptBlock(ctx);
  if (threadSystemPrompt !== null) blocks.push(threadSystemPrompt);

  // Eval-runner seam (test-gated; always null in production): candidate C is
  // the shipped prompt with a find/replace diff applied. See promptVariant.ts.
  const variant = getPromptVariant();
  if (variant) blocks.splice(0, blocks.length, ...applyPromptVariant(blocks, variant));

  // One system breakpoint, on the last system block that rendered, not two
  // (stable-core + threadSystemPrompt): the other slot goes to the durable
  // message breakpoint in anthropic.ts, without which the entire message
  // history is re-cached on every run instead of being read back. A single
  // breakpoint costs a rare one-time rewrite of the core when someone edits a
  // thread prompt; a split would cost a full history rewrite every turn.
  if (blocks.length > 0) {
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: CACHE_CONTROL };
  }

  return blocks;
}
