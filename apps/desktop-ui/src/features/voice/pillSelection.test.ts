import { describe, expect, it } from 'vitest';
import { defaultPillSelection, lastSpeakerAgentId, type SpeakerMessage } from './pillSelection';

const msg = (role: string, agentId: string | null): SpeakerMessage => ({ role, agentId });

describe('pill default selection', () => {
  it('solo thread auto-targets the single agent', () => {
    expect(defaultPillSelection([], ['a1'])).toEqual(['a1']);
    // …even with no prior messages and regardless of who "spoke".
    expect(defaultPillSelection([msg('user', null)], ['a1'])).toEqual(['a1']);
  });

  it('empty thread with no participants selects nobody', () => {
    expect(defaultPillSelection([], [])).toEqual([]);
  });

  it('group thread defaults to the last agent who spoke', () => {
    const messages = [
      msg('user', null),
      msg('assistant', 'a1'),
      msg('assistant', 'a2'),
      msg('user', null),
    ];
    expect(defaultPillSelection(messages, ['a1', 'a2', 'a3'])).toEqual(['a2']);
  });

  it('group thread with no assistant messages yet selects nobody', () => {
    expect(defaultPillSelection([msg('user', null)], ['a1', 'a2'])).toEqual([]);
  });

  it('ignores assistant messages from agents no longer in the thread', () => {
    const messages = [msg('assistant', 'gone'), msg('assistant', 'a1')];
    expect(lastSpeakerAgentId(messages, ['a1', 'a2'])).toBe('a1');
    // 'gone' spoke most recently but isn't a participant → skip to 'a1'.
    const messages2 = [msg('assistant', 'a1'), msg('assistant', 'gone')];
    expect(lastSpeakerAgentId(messages2, ['a1', 'a2'])).toBe('a1');
  });
});
