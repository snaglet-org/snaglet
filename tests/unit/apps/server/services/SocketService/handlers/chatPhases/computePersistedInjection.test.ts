/**
 * computePersistedInjection — one-time project-overview stamp on a thread's
 * first human message. The gate counts only real user sends
 * (countUserMessagesByThreadId), not all rows: an agent-initiated thread
 * already has a `[thread started]` thread_event row at turn zero.
 */

const countUserMessagesByThreadId = jest.fn();
const buildProjectLineageString = jest.fn();
const warn = jest.fn();

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    countUserMessagesByThreadId: (...a: unknown[]) => countUserMessagesByThreadId(...a),
  },
}));

jest.mock('@server/services/ToolService/lib/buildProjectLineageString', () => ({
  buildProjectLineageString: (...a: unknown[]) => buildProjectLineageString(...a),
}));

jest.mock('@server/services/LogsService', () => ({
  LogsService: { warn: (...a: unknown[]) => warn(...a) },
}));

import { computePersistedInjection } from '@server/services/SocketService/handlers/chatPhases/computePersistedInjection';

beforeEach(() => {
  countUserMessagesByThreadId.mockReset();
  buildProjectLineageString.mockReset();
  warn.mockReset();
});

describe('computePersistedInjection', () => {
  it('fires on an agent-started thread — a [thread started] event is not the opener', async () => {
    // Agent-initiated thread: an author-less thread_event row already exists,
    // but zero real user sends → the first human message must still get the
    // one-time injection. The gate must key on the user-message count.
    countUserMessagesByThreadId.mockResolvedValue(0);
    buildProjectLineageString.mockResolvedValue('PROJECT OVERVIEW: Vega');

    const result = await computePersistedInjection('thread-1');

    expect(result).toBe('PROJECT OVERVIEW: Vega');
    expect(countUserMessagesByThreadId).toHaveBeenCalledWith('thread-1');
    expect(buildProjectLineageString).toHaveBeenCalledWith('thread-1');
  });

  it('returns null once a real user message already exists (not the opener)', async () => {
    countUserMessagesByThreadId.mockResolvedValue(1);

    const result = await computePersistedInjection('thread-1');

    expect(result).toBeNull();
    expect(buildProjectLineageString).not.toHaveBeenCalled();
  });

  it('returns null (best-effort) when no enclosing project carries overview text', async () => {
    countUserMessagesByThreadId.mockResolvedValue(0);
    buildProjectLineageString.mockResolvedValue(null);

    const result = await computePersistedInjection('thread-1');

    expect(result).toBeNull();
  });
});
