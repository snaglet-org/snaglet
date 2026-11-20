/**
 * runModeBlock — realtime threads, routing modes and delivery.
 *
 * The single home for thread coordination facts: the live-thread framing
 * (solo and group alike), the routing modes explained once, @-mention
 * mechanics, what a post does and does not prove (the no-fabricated-wakes
 * rule), posting only when there is something new, and ending a turn. It
 * teaches delivery semantics, not a collaboration style: how and when to bring
 * an agent in, take one out or leave (with the user-configured participation
 * exceptions) and how to word a handoff are the snaglet-group-threads skill's,
 * whose catalog line says when to load it, and the `thread` tool's description
 * lists its ops, so this block points at neither.
 *
 * It deliberately does not branch on ctx.isGroup, ctx.dispatchMode or the peer
 * list — thread-variable state that would bust the cached prefix the moment a
 * participant joins or the mode changes. Who is here arrives in append-only
 * `thread_event` messages, the active mode in the turn-context tail.
 *
 * Three variants, each fixed for a thread's life or an agent row's, so the
 * text stays byte-identical turn to turn:
 *
 * - A subagent helper (isHelperRun) works alone in its own hidden thread and
 *   cannot DM, hand off or bring anyone in, so it gets only the
 *   no-fabricated-wakes rule and how to end its turn.
 * - ctx.isDm: a DM / home thread (`threads.kind = 'dm'`) holds the user and
 *   this one agent, and its kind never changes, so it gets a fixed variant
 *   with nothing about routing, mentions or handoffs: the reply goes to the
 *   user. How to reach agents in another thread (its routing mode, @-tags) is
 *   the snaglet-other-threads skill, loaded when the agent sends there.
 * - Every other thread gets the routing and delivery facts.
 */

import { isHelperRun } from '../helperRun';
import type { BlockBuilder } from '../types';

const RUN_MODE_HEAD = `## Threads and handoffs
You are in a live thread: you are woken when a message reaches you, and the thread persists. Thread events show the participants and your turn context gives the routing mode; never call a 1:1 thread a group.
- **Your reply is the message.** It posts to this thread, so talk to a teammate here in your reply; \`thread\` op \`send\` is only for another thread.
- **Routing modes.** In \`mentioned\` mode, tag a participant who needs to act; an untagged reply does not wake them, and a bare name is silent. In \`all\` mode, replies reach all participants. Untagged messages remain in thread history. To reach someone, tag them; don't change the thread's routing mode to do it.
- **Handing off.** \`@<Name>\` in your reply wakes an idle teammate or reaches a running one; there is no separate wake tool, and a mention only in your private reasoning never lands. Only participants in this thread are reachable, and self-mentions are dropped. Claim a notification or handoff only after performing the action that delivers it. Posting proves delivery was initiated, not that the recipient read, accepted or completed the work.`;

/** Said once per variant: an agent posts to be read, not to show it is alive. */
const POST_ONLY_NEW = 'Post only when you have something new; never a "still waiting" post.';

const RUN_MODE_TAIL = `
- **Ending your turn.** Once you stop, you are idle until a new message, mention or trigger wakes you, so don't end by saying you are about to do something: finish it, or hand it off. ${POST_ONLY_NEW}`;

const DM_MODE = `## Threads
This is a direct conversation between you and the user: your reply is the message and goes to them, and no one else is here. You are woken when they write, and the thread persists.
- **Ending your turn.** Once you stop, you are idle until a new message or trigger wakes you, so don't end by saying you are about to do something: finish it, or say what is left. ${POST_ONLY_NEW}`;

/**
 * A helper's thread holds only it and its orchestrator, and helpers take no
 * part in DMs or handoffs, so none of that guidance applies. That its reply is
 * a report delivered to its orchestrator, and how to ask it a question, are
 * in its own system prompt (subagents/subagentText helperSystemPrompt).
 */
const HELPER_MODE = `## Your thread
No teammates are here to \`@\`-mention, so never claim you woke, notified or handed work to anyone. Don't end by saying you are about to do something: finish it, or say in your report what is left.`;

const RUN_MODE = `${RUN_MODE_HEAD}${RUN_MODE_TAIL}`;

export const runModeBlock: BlockBuilder = async (ctx) => {
  if (isHelperRun(ctx)) return { type: 'text', text: HELPER_MODE };
  if (ctx.isDm) return { type: 'text', text: DM_MODE };
  return { type: 'text', text: RUN_MODE };
};
