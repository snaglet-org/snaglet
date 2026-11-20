/**
 * resolveAgentVoice — per-agent voice id (real agents.voice column, default
 * fallback) + default speaking-target rules.
 */

jest.mock('@server/services/LogsService', () => ({
  LogsService: { warn: jest.fn(), error: jest.fn(), socket: { event: jest.fn() } },
}));

const agentGet = jest.fn();
jest.mock('@server/services/AgentService', () => ({
  agentService: { get: (...a: unknown[]) => agentGet(...a) },
}));

const listRecent = jest.fn();
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { listRecentByThreadId: (...a: unknown[]) => listRecent(...a) },
}));

// Every catalog voice is installed unless a test sets `mockInstalled`.
const ALL_VOICES = [
  'en_US-amy-medium',
  'en_US-ryan-medium',
  'en_GB-alan-medium',
  'en_US-joe-medium',
];
let mockInstalled: string[] = ALL_VOICES;
jest.mock('@server/services/voice/installedVoices', () => ({
  installedVoiceIds: async () => mockInstalled,
}));

import {
  resolveAgentVoiceId,
  resolveDefaultTargets,
} from '@server/services/SocketService/voiceSession/resolveAgentVoice';
import { DEFAULT_VOICE_ID } from '@server/services/SocketService/voiceSession/constants';

afterEach(() => {
  agentGet.mockReset();
  listRecent.mockReset();
  mockInstalled = ALL_VOICES;
});

describe('resolveAgentVoiceId', () => {
  it('returns the configured voice when set', async () => {
    agentGet.mockResolvedValue({ id: 'a', name: 'Nova', voice: 'en_US-amy-medium' });
    expect(await resolveAgentVoiceId('a')).toBe('en_US-amy-medium');
  });

  it('falls back to the deterministic default when voice is null/absent', async () => {
    agentGet.mockResolvedValue({ id: 'a', name: 'Nova', voice: null });
    expect(await resolveAgentVoiceId('a')).toBe(DEFAULT_VOICE_ID);
  });

  it('falls back to the default when the agent lookup fails', async () => {
    agentGet.mockRejectedValue(new Error('nope'));
    expect(await resolveAgentVoiceId('a')).toBe(DEFAULT_VOICE_ID);
  });

  it('speaks an uninstalled saved voice as the first installed one, keeping the saved id', async () => {
    const agent = { id: 'a', name: 'Nova', voice: 'en_US-joe-medium' };
    agentGet.mockResolvedValue(agent);
    mockInstalled = ['en_US-ryan-medium', 'en_GB-alan-medium'];
    expect(await resolveAgentVoiceId('a')).toBe('en_US-ryan-medium');
    expect(agent.voice).toBe('en_US-joe-medium');

    // An agent with no voice follows the default the same way.
    agentGet.mockResolvedValue({ id: 'b', name: 'Clio', voice: null });
    expect(await resolveAgentVoiceId('b')).toBe('en_US-ryan-medium');

    // Reinstalling the saved voice brings it back.
    agentGet.mockResolvedValue(agent);
    mockInstalled = ['en_US-ryan-medium', 'en_US-joe-medium'];
    expect(await resolveAgentVoiceId('a')).toBe('en_US-joe-medium');
  });

  it('keeps an Apple voice as saved, whatever is installed', async () => {
    agentGet.mockResolvedValue({ id: 'a', name: 'Nova', voice: 'apple:com.apple.voice.en-US.Zoe' });
    mockInstalled = [];
    expect(await resolveAgentVoiceId('a')).toBe('apple:com.apple.voice.en-US.Zoe');
  });
});

describe('resolveDefaultTargets', () => {
  it('solo thread → the one agent', async () => {
    expect(await resolveDefaultTargets('t', ['agent-A'])).toEqual(['agent-A']);
  });

  it('group → the last agent who spoke', async () => {
    listRecent.mockResolvedValue([
      { role: 'assistant', agentId: 'agent-A' },
      { role: 'user', content: 'x' },
      { role: 'assistant', agentId: 'agent-B' },
    ]);
    expect(await resolveDefaultTargets('t', ['agent-A', 'agent-B'])).toEqual(['agent-B']);
  });

  it('group with no prior speaker → empty (nothing to target)', async () => {
    listRecent.mockResolvedValue([{ role: 'user', content: 'x' }]);
    expect(await resolveDefaultTargets('t', ['agent-A', 'agent-B'])).toEqual([]);
  });
});
