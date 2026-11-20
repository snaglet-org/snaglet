/**
 * The DM pair key (`threads.dm_pair_key`): the two `members.id` values
 * of a DM thread, sorted and joined with `:`. Sorting makes the key the same
 * whichever member starts the DM, so the unique index on it allows exactly
 * one DM thread per pair.
 */
export function dmPairKey(memberA: string, memberB: string): string {
  if (!memberA || !memberB) throw new Error('dmPairKey needs two member ids');
  if (memberA === memberB) throw new Error('A DM needs two different members');
  return memberA < memberB ? `${memberA}:${memberB}` : `${memberB}:${memberA}`;
}
