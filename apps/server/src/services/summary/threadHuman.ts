/**
 * The human of a thread: whose facts an agent may propose there, and whose
 * kept facts recall and search may surface there. Kept apart from
 * memoryExtraction so recall and search can use it without pulling in the
 * extraction pipeline.
 */

import { Members } from '@snaglet/db/tables/members';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { Users } from '@snaglet/db/tables/users';

/**
 * The member id of the thread's single human participant. Zero or several
 * humans is ambiguous, so the answer is null rather than a guess.
 */
export async function resolveProposalMemberId(threadId: string): Promise<string | null> {
  const participants = await ThreadParticipants.listByThread(threadId);
  const humans = participants.filter((participant) => participant.kind === 'user');
  return humans.length === 1 ? (humans[0]?.memberId ?? null) : null;
}

/** A member's display name (the user's name), or null when there is none to give. */
export async function resolveMemberName(memberId: string): Promise<string | null> {
  const member = await Members.findById(memberId);
  if (!member?.userId) return null;
  const user = await Users.findById(member.userId);
  return user?.name?.trim() || null;
}
