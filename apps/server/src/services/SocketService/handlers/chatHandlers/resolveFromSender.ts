import { Agents } from '@snaglet/db/tables/agents';
import { Users } from '@snaglet/db/tables/users';

/**
 * Resolution outcome for a caller-supplied `from` label on `socket:chat:send`
 * (see `ChatSendPayload.from`).
 */
export type ResolvedFromSender =
  | { kind: 'agent'; agentId: string }
  | { kind: 'user'; userId: string }
  | { kind: 'external'; label: string };

/**
 * Resolve a raw `from` label to a real identity, falling back to "external
 * sender" when nothing matches. This is what lets a caller on the MCP/API
 * send path (e.g. an orchestrator posting via snaglet-notify/send-thread-message)
 * stamp real per-message sender provenance instead of baking "[from:x]" into
 * the message text.
 *
 * Resolution order — agent -> member (realized as a user) -> external:
 *   1. Agent, by name (the common human-typed label, case-insensitive),
 *      then by id. A match is attributed normally: role='assistant',
 *      agentId set, exactly like any other agent-authored message.
 *   2. Member, by name then id — realized as a lookup against `users`.
 *      `members` has no name column of its own (see MemberModel.ts): the
 *      nameable identity a member wraps is always an agent or a user, so
 *      resolving those two tables IS resolving against the member registry.
 *      A match is attributed normally: role='user', userId set to that user.
 *   3. External — nothing resolved. The raw (trimmed) label is returned so
 *      the caller can store it verbatim on messages.external_sender. It
 *      carries no real identity: any rendering path that puts this label in
 *      front of a model must treat it as untrusted display text (see
 *      neutralizeSystemFraming) — a forged label is a bare string, not proof
 *      of who sent it.
 */
export async function resolveFromSender(from: string): Promise<ResolvedFromSender> {
  const trimmed = from.trim();

  // 1. Agent — name first (what a human/orchestrator actually types), then id.
  const agent =
    (await Agents.findByName(trimmed)) ?? (await Agents.findById(trimmed).catch(() => null));
  if (agent) return { kind: 'agent', agentId: agent.id };

  // 2. Member, realized as a user — name first, then id.
  const user =
    (await Users.findByName(trimmed)) ?? (await Users.findById(trimmed).catch(() => null));
  if (user) return { kind: 'user', userId: user.id };

  // 3. External — no match; caller-claimed label only, not a real identity.
  return { kind: 'external', label: trimmed };
}
