// Mid-run peer injection. When a peer or user message is queued for a running
// agent, deliver it into that agent's live context at the next client-tool
// seam, gated by dispatch mode + sender: a direct user message is always
// injected, and peer messages follow the thread's routing mode (see
// decideMidRunInjection). A running agent never has to call a tool to see
// what arrived.

import { resolveAuthorLabel } from '@snaglet/shared/constants/systemAgents';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { noteMessageInjected } from '@server/services/subagents/resultVisibility';
import { decideMidRunInjection, type DispatchMode, type SenderKind } from './injectionPolicy';
import { neutralizeSystemFraming } from '@server/services/ToolService/lib/untrustedContent';
import { raiseAmbientChain, type ChainStamp } from '@server/services/customHooks/chainStamp';

import { formatPeerMessage } from './peerMessageFormat';

/**
 * Drain the messages queued for a running agent and return those to inject this
 * seam, formatted as text blocks' bodies.
 *
 * Messages that reach this agent (see decideMidRunInjection) go out as
 * `[message from <name>] <text>`, preceded by any teammate messages held since
 * the last delivery. Held messages that no later message releases are seen on
 * the agent's next turn via thread history, so nothing is lost.
 *
 * The run acts on what it injects inside this same run, so it takes on their
 * hook chain context: its ambient depth becomes the max of its own
 * and the injected messages' stamps, never lower. A person's message carries
 * no stamp and leaves it unchanged. Deferred messages don't raise it; their
 * post-run redispatch carries their stamp.
 */
export function drainInjectablePeerMessages(args: {
  threadId: string;
  agentId: string;
  mode: DispatchMode;
}): string[] {
  const kindOf = (m: { reason: string; senderUserId?: string | null }): SenderKind =>
    // Reason 'system' is the platform narrating thread state (threadEvents), so
    // it is checked first: those rows are author-less by construction, and the
    // userId test below would otherwise misfile them as a peer message and let
    // routing mode suppress them. The human user's voice carries a userId (no
    // agentId); anything with an agent author is a peer message.
    m.reason === 'system' ? 'system' : m.senderUserId ? 'user' : 'peer';
  const reaches = (m: { reason: string; senderUserId?: string | null }): boolean =>
    decideMidRunInjection(args.mode, kindOf(m), m.reason === 'mentioned') === 'inject';

  // Everything up to the last message that reaches this agent goes out, oldest
  // first. A teammate message that did not tag this running agent is held until
  // then, so a mention arrives after the group talk it followed, not alone.
  // Held messages after the last one that reaches the agent stay queued.
  const drained = pendingAgentMessages.takeThroughLast(args.threadId, args.agentId, reaches);
  const inject: string[] = [];
  const stamps: (ChainStamp | null)[] = [];
  for (const m of drained) {
    // A tool-dispatch seed (thread_send) that was also recorded for the
    // post-run re-dispatch: now that this run actually saw it, strike it from
    // that backstop so the agent is not woken to answer it a second time.
    if (m.sourceMessageId) {
      activeRunTracker.markSeedInjected(args.threadId, m.sourceMessageId, args.agentId);
      // A subagent result delivered mid-run counts as seen by this run.
      noteMessageInjected(args.threadId, args.agentId, m.sourceMessageId);
    }
    // The run takes on the hook chain context of what it acts on, never lower.
    // A held message was not acted on until now, so it counts from here.
    stamps.push(m.chain ?? null);
    // A thread_event line goes in verbatim — the same bytes the agent would
    // read from replay on its next wake, so the mid-run and replayed copies
    // cannot describe the same change differently. Parts of some lines (agent
    // display names) are user-supplied, so it still gets the framing escape.
    inject.push(
      kindOf(m) === 'system'
        ? neutralizeSystemFraming(m.content)
        : formatPeerMessage(
            // A queued message is always fresh, so a ghost sender is a system
            // post (hook notice), never a deleted agent's repointed history.
            resolveAuthorLabel({ agentId: m.senderAgentId, fallbackName: m.senderName }),
            m.content
          )
    );
  }
  raiseAmbientChain(stamps);
  return inject;
}
