jest.mock('@server/services/WebSocketService', () => ({ addChannelObserver: jest.fn() }));
jest.mock('@server/services/ToolService/tools/system/computer/tool', () => ({
  emitEmotionCursor: jest.fn(),
}));

import {
  CursorEmotionService,
  CURSOR_EMOTION_RULES,
  RENEW_MS,
} from '@server/services/CursorEmotionService';

const A = 'test-agent-a';
const B = 'test-agent-b';

describe('CursorEmotionService', () => {
  let svc: CursorEmotionService;
  let overlay: jest.Mock;
  let browser: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    overlay = jest.fn();
    browser = jest.fn();
    svc = new CursorEmotionService({ overlay, browser });
  });
  afterEach(() => jest.useRealTimers());

  const f = (type: string, payload: Record<string, unknown>, thread = 'test-thread-1') =>
    svc.observe({ type, payload }, thread);
  const emotions = () => overlay.mock.calls.map((c) => c[1]);

  it('has a small rules table keyed by frame type', () => {
    expect(Object.keys(CURSOR_EMOTION_RULES).sort()).toEqual(
      [
        'socket:agent:status',
        'socket:chat:aborted',
        'socket:clarification:request',
        'socket:clarification:timeout',
        'socket:delta',
        'socket:done',
        'socket:thinking:chunk',
        'socket:tool:call',
        'socket:tool:result',
      ].sort()
    );
  });

  it('thinking starts on a chunk, renews while chunks come, ends ~3s after the last', () => {
    f('socket:thinking:chunk', { agentId: A, text: 'hm' });
    expect(overlay).toHaveBeenCalledWith(A, 'thinking', undefined, 'start');
    expect(browser).toHaveBeenCalledWith(A, 'thinking', 3500);
    jest.advanceTimersByTime(2000);
    f('socket:thinking:chunk', { agentId: A, text: 'more' });
    jest.advanceTimersByTime(2999);
    expect(emotions()).not.toContain('neutral');
    jest.advanceTimersByTime(2);
    expect(emotions().at(-1)).toBe('neutral');
    const n = overlay.mock.calls.length;
    jest.advanceTimersByTime(20_000);
    expect(overlay.mock.calls.length).toBe(n);
  });

  it('re-emits every ~2.5s while thinking holds, and emits neutral exactly once on the way back', () => {
    f('socket:thinking:chunk', { agentId: A, text: 'x' });
    jest.advanceTimersByTime(RENEW_MS);
    expect(emotions()).toEqual(['thinking', 'thinking']);
    jest.advanceTimersByTime(600);
    expect(emotions()).toEqual(['thinking', 'thinking', 'neutral']);
  });

  it('typing and other frames set nothing, and typing ends thinking at once', () => {
    f('socket:delta', { agentId: A, text: 'hi' });
    f('socket:tool:call', { agentId: A, callId: 'c1', toolName: 'shell', toolInput: {} });
    f('socket:tool:result', { agentId: A, callId: 'c1' });
    f('socket:unrelated', { agentId: A });
    expect(overlay).not.toHaveBeenCalled();
    f('socket:thinking:chunk', { agentId: A, text: 'x' });
    f('socket:delta', { agentId: A, text: 'hi' });
    expect(emotions()).toEqual(['thinking', 'neutral']);
  });

  it('is curious from the ask call until its result, with the question as the label', () => {
    f('socket:thinking:chunk', { agentId: A, text: 'x' });
    f('socket:tool:call', {
      agentId: A,
      callId: 'c1',
      toolName: 'ask',
      toolInput: { questions: [{ prompt: 'Which   color?' }] },
    });
    expect(overlay).toHaveBeenLastCalledWith(A, 'curious', 'Which color?', 'start');
    f('socket:clarification:request', {
      agentId: A,
      callId: 'c1',
      request: { questions: [{ prompt: 'Which color?' }] },
    });
    expect(emotions()).toEqual(['thinking', 'curious']);
    jest.advanceTimersByTime(RENEW_MS * 3);
    expect(emotions().filter((e) => e === 'curious')).toHaveLength(4);
    f('socket:tool:result', { agentId: A, callId: 'c1' });
    expect(emotions().at(-1)).toBe('neutral');
    expect(overlay).toHaveBeenLastCalledWith(A, 'neutral', undefined, 'settle');
  });

  it('marks question renewals so renderers do not replay stale question speech', () => {
    f('socket:clarification:request', {
      agentId: A,
      callId: 'c-renew',
      request: { questions: [{ prompt: 'Which file?' }] },
    });
    expect(overlay).toHaveBeenLastCalledWith(A, 'curious', 'Which file?', 'start');

    jest.advanceTimersByTime(RENEW_MS);

    expect(overlay).toHaveBeenLastCalledWith(A, 'curious', 'Which file?', 'renew');
  });

  it('an answered ask (tool:call + clarification:request + tool:result, one callId) never renews again', () => {
    f('socket:tool:call', {
      agentId: A,
      callId: 'c-ans',
      toolName: 'ask',
      toolInput: { questions: [{ prompt: 'Which file?' }] },
    });
    f('socket:clarification:request', {
      agentId: A,
      callId: 'c-ans',
      request: { questions: [{ prompt: 'Which file?' }] },
    });
    jest.advanceTimersByTime(RENEW_MS);
    f('socket:tool:result', { agentId: A, callId: 'c-ans' });
    const n = overlay.mock.calls.length;
    expect(overlay).toHaveBeenLastCalledWith(A, 'neutral', undefined, 'settle');
    jest.advanceTimersByTime(RENEW_MS * 4);
    expect(overlay.mock.calls.length).toBe(n);
  });

  it('curious ends on a clarification timeout frame (no agentId) and uses a default label', () => {
    f('socket:clarification:request', { agentId: A, callId: 'c2', request: { questions: [] } });
    expect(overlay).toHaveBeenLastCalledWith(A, 'curious', 'Asking you something', 'start');
    f('socket:clarification:timeout', { callId: 'c2' });
    expect(emotions()).toEqual(['curious', 'neutral']);
  });

  it('an aborted or finished run clears its open asks and thinking', () => {
    f('socket:clarification:request', { agentId: A, callId: 'c5', request: {} });
    f('socket:thinking:chunk', { agentId: A, text: 'x' }, 'test-thread-2');
    f('socket:clarification:request', { agentId: B, callId: 'c6', request: {} });
    // abort of agent A on thread 1 only: A falls back to thinking (thread 2), B stays curious
    f('socket:chat:aborted', { agentId: A, threadId: 'test-thread-1' });
    expect(overlay).toHaveBeenLastCalledWith(A, 'thinking', undefined, 'start');
    expect(emotions().filter((e) => e === 'neutral')).toEqual([]);
    // reaper frame has no agentId: clears every agent on that thread
    f('socket:chat:aborted', { reaped: true });
    expect(overlay).toHaveBeenLastCalledWith(B, 'neutral', undefined, 'settle');
    // a done frame also clears an ask whose result never came
    f('socket:clarification:request', { agentId: A, callId: 'c7', request: {} });
    f('socket:done', { agentId: A, reply: '' });
    expect(overlay).toHaveBeenLastCalledWith(A, 'thinking', undefined, 'start');
    f('socket:done', { agentId: A, reply: '' }, 'test-thread-2');
    expect(overlay).toHaveBeenLastCalledWith(A, 'neutral', undefined, 'settle');
  });

  it('trims a long question to ~160 characters', () => {
    f('socket:clarification:request', {
      agentId: A,
      callId: 'c3',
      request: { questions: [{ prompt: 'q'.repeat(400) }] },
    });
    expect((overlay.mock.calls[0][2] as string).length).toBe(160);
  });

  it('curious beats thinking and thinking returns when the question settles', () => {
    f('socket:thinking:chunk', { agentId: A, text: 'x' }, 'test-thread-2');
    f('socket:clarification:request', { agentId: A, callId: 'c4', request: {} }, 'test-thread-1');
    f('socket:thinking:chunk', { agentId: A, text: 'y' }, 'test-thread-2');
    expect(emotions()).toEqual(['thinking', 'curious']);
    f('socket:clarification:timeout', { callId: 'c4' }, 'test-thread-1');
    expect(emotions()).toEqual(['thinking', 'curious', 'thinking']);
  });

  it('derives per thread and per agent', () => {
    f('socket:thinking:chunk', { agentId: A, text: 'x' }, 'test-thread-1');
    f('socket:thinking:chunk', { agentId: A, text: 'x' }, 'test-thread-2');
    f('socket:delta', { agentId: A, text: 'x' }, 'test-thread-1');
    expect(emotions()).toEqual(['thinking']); // thread 2 still thinking
    f('socket:thinking:chunk', { agentId: B, text: 'x' }, 'test-thread-1');
    expect(overlay).toHaveBeenLastCalledWith(B, 'thinking', undefined, 'start');
    f('socket:delta', { agentId: A, text: 'x' }, 'test-thread-2');
    expect(overlay).toHaveBeenLastCalledWith(A, 'neutral', undefined, 'settle');
  });

  it('never throws into a turn when a sink throws or rejects', () => {
    const bad = new CursorEmotionService({
      overlay: () => {
        throw new Error('x');
      },
      browser: () => Promise.reject(new Error('y')),
    });
    expect(() =>
      bad.observe({ type: 'socket:thinking:chunk', payload: { agentId: A } }, 't')
    ).not.toThrow();
  });
});
