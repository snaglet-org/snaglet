/**
 * mergeMentions — the redispatch wake set is the UNION of the @mentions in
 * every undelivered message it covers, so a peer named only in an earlier
 * message still wakes.
 */
import { mergeMentions } from '@server/services/SocketService/dispatch/buildDispatchDeps';

const none = { mentionedAgentIds: [], hasMentions: false, rawMentions: [] };

describe('mergeMentions', () => {
  it('unions ids across messages, first-seen order, no duplicates', () => {
    const merged = mergeMentions([
      { mentionedAgentIds: ['venus'], hasMentions: true, rawMentions: ['Venus'] },
      { mentionedAgentIds: ['clio', 'venus'], hasMentions: true, rawMentions: ['Clio', 'Venus'] },
    ]);
    expect(merged).toEqual({
      mentionedAgentIds: ['venus', 'clio'],
      hasMentions: true,
      rawMentions: ['Venus', 'Clio'],
    });
  });

  it('has mentions when only an earlier (non-seed) message mentions someone', () => {
    const merged = mergeMentions([
      none,
      { mentionedAgentIds: ['clio'], hasMentions: true, rawMentions: ['Clio'] },
    ]);
    expect(merged.hasMentions).toBe(true);
    expect(merged.mentionedAgentIds).toEqual(['clio']);
  });

  it('stays mention-free when no message mentions anyone', () => {
    expect(mergeMentions([none, none]).hasMentions).toBe(false);
  });

  it('returns a single parse unchanged', () => {
    const one = { mentionedAgentIds: ['clio'], hasMentions: true, rawMentions: ['Clio'] };
    expect(mergeMentions([one])).toBe(one);
  });
});
