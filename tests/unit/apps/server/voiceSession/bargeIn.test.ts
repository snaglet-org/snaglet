/**
 * bargeIn — inject-vs-abort decision + the precise heard-up-to marker.
 */

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@server/services/LogsService', () => ({
  LogsService: { warn: jest.fn(), error: jest.fn(), socket: { event: jest.fn() } },
}));

const findById = jest.fn();
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { findById: (...a: unknown[]) => findById(...a) },
}));

import {
  decideBargeInAction,
  resolveHeardUpToLine,
} from '@server/services/SocketService/voiceSession/bargeIn';
import {
  addSynthesizedMs,
  addSpokenText,
  reconcileUtteranceId,
  __resetDurations,
} from '@server/services/SocketService/voiceSession/ttsDurationTracker';

afterEach(() => {
  findById.mockReset();
  __resetDurations();
});

describe('decideBargeInAction', () => {
  it('injects when the interrupted agent is mid-tool-run', () => {
    expect(decideBargeInAction({ toolInFlight: true })).toBe('inject');
  });
  it('aborts + redispatches when mid-speech (no tools in flight)', () => {
    expect(decideBargeInAction({ toolInFlight: false })).toBe('abort-redispatch');
  });
});

describe('resolveHeardUpToLine', () => {
  it('slices at the client charOffset when no playedMs', async () => {
    findById.mockResolvedValue({ content: 'Hello world foo' });
    const line = await resolveHeardUpToLine({ utteranceId: 'u', charOffset: 5 });
    expect(line).toBe('[voice] user heard up to: "Hello"');
  });

  it('prefers playedMs and snaps to a word boundary via synthesized duration', async () => {
    findById.mockResolvedValue({ content: 'one two three four' });
    addSynthesizedMs('u', 1000); // total 1000ms
    // 500ms → ratio 0.5 → offset ~9 → snapped back to the "one two" boundary.
    const line = await resolveHeardUpToLine({ utteranceId: 'u', playedMs: 500 });
    expect(line).toBe('[voice] user heard up to: "one two"');
  });

  it('falls back to charOffset when duration is unknown', async () => {
    findById.mockResolvedValue({ content: 'alpha beta gamma' });
    const line = await resolveHeardUpToLine({ utteranceId: 'u', playedMs: 500, charOffset: 10 });
    expect(line).toBe('[voice] user heard up to: "alpha beta"');
  });

  it('returns null for a missing row or empty content', async () => {
    findById.mockResolvedValue(null);
    expect(await resolveHeardUpToLine({ utteranceId: 'u', charOffset: 3 })).toBeNull();
  });

  it('returns null when no utteranceId', async () => {
    expect(await resolveHeardUpToLine(undefined)).toBeNull();
  });

  // Streaming TTS: the user can barge in mid-stream, before the row
  // persists — the id is the synthetic streaming id and there is no DB row yet.
  it('resolves mid-stream from tracker spoken text with only the synthetic id', async () => {
    // No DB row exists for the synthetic id.
    findById.mockResolvedValue(null);
    addSpokenText('run1:1', 'one two three four');
    addSynthesizedMs('run1:1', 1000);
    const line = await resolveHeardUpToLine({ utteranceId: 'run1:1', playedMs: 500 });
    expect(line).toBe('[voice] user heard up to: "one two"');
    // The DB was never consulted — the tracker text carried it.
    expect(findById).not.toHaveBeenCalled();
  });

  it('still resolves after reconcile when queried by the real messageId', async () => {
    findById.mockResolvedValue(null);
    addSpokenText('run1:1', 'alpha beta gamma');
    addSynthesizedMs('run1:1', 900);
    reconcileUtteranceId('run1:1', 'msg-1');
    // A caller that only knows the persisted messageId still resolves via the alias.
    const line = await resolveHeardUpToLine({ utteranceId: 'msg-1', charOffset: 5 });
    expect(line).toBe('[voice] user heard up to: "alpha"');
  });

  it('falls back to the DB row (via reconciled messageId) when no tracker text', async () => {
    findById.mockResolvedValue({ content: 'from the persisted row' });
    // Duration tracked, but no spoken text recorded (e.g. cleared) → DB fallback.
    addSynthesizedMs('run1:1', 500);
    reconcileUtteranceId('run1:1', 'msg-1');
    const line = await resolveHeardUpToLine({ utteranceId: 'run1:1', charOffset: 8 });
    expect(findById).toHaveBeenCalledWith('msg-1');
    expect(line).toBe('[voice] user heard up to: "from the"');
  });
});
