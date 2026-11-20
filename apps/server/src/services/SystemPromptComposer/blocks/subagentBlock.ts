/**
 * subagentBlock — when and how to hand work to subagent helpers.
 *
 * Gated on the `subagent` tool, so helpers themselves (denied it) and agents
 * without it never see it. It carries no model list: the agent looks the
 * models up with `subagent` op "models" (subagents/helperModels), the same set
 * `op:start` accepts, so the prompt stays small and never goes stale.
 *
 * Constant text once the tool is present: stable per agent.
 */
import type { BlockBuilder } from '../types';

// When and why to use a helper: it chooses a mechanism, not a management
// style. What a helper is and the op mechanics (start several in one turn,
// wait, send, stop, pause, remove, list; helpers can't ask the user) live on
// the subagent tool's own description. Reports arrive asynchronously, so timed
// and recurring work goes to automations; the example phrasings stay because
// an agent asked to "wake me in 2 minutes" briefed a helper to wait (seen
// live). The never-guess-a-report rule is on the tool too, but stays here as
// well, right after the exception it limits: without it an agent invented a
// helper's report instead of ending its turn (seen live).
const PART_1 = `## Subagents
Use \`subagent\` helpers when the user asks for parallel work or the job splits into independent pieces (one helper per piece, a few at a time), when a self-contained task (research, a draft, a review, a check) would flood your context, or when a long job would hold up the conversation. Do the work yourself when it is quick, when each step depends on the last, or when it needs the user's judgment. Helpers return reports asynchronously; for scheduled or recurring work ("in 10 minutes", "tomorrow at 9", "every weekday"), use the \`automation\` tool rather than keeping a helper waiting.`;

const PART_2 = `

Pick a small, fast model for lookups, extraction and summaries and a strong one for writing, code, planning and judgment calls (\`subagent\` op \`models\` lists yours). A helper sees only its brief: say in it what done looks like and where results go, and for long work point it at the checklist in a task table or the work's own doc. Ending your turn to await a report is the one exception to finishing what you announce; never write or guess a report yourself.`;

/** Group threads only: a DM / home thread has no teammates to @-mention. */
const TEAMMATE_LINE = ' A teammate in your thread is reached with an `@`-mention, not a helper.';
const GUIDANCE = `${PART_1}${TEAMMATE_LINE}${PART_2}`;
const DM_GUIDANCE = `${PART_1}${PART_2}`;

export const subagentBlock: BlockBuilder = async (ctx) => {
  if (!ctx.agentTools?.some((at) => at.tool.id === 'subagent')) return null;
  // No cache_control here — composeSystemPrompt places the single system
  // breakpoint on whichever block renders last.
  return { type: 'text', text: ctx.isDm ? DM_GUIDANCE : GUIDANCE };
};
