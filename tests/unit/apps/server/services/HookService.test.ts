const mockDebug = jest.fn();

jest.mock('../../../../../apps/server/src/config/logger', () => ({
  logger: {
    debug: (...args: unknown[]) => mockDebug(...args),
  },
}));

import { hooks } from '@server/services/HookService';

describe('HookService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers a listener with on(), emits payload, and logs debug', () => {
    const handler = jest.fn();
    hooks.on('agent:create', handler);

    expect(hooks.listenerCount('agent:create')).toBe(1);

    hooks.emit('agent:create', { id: 'a1' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ id: 'a1' });
    expect(mockDebug).toHaveBeenCalledWith('hook: agent:create');

    hooks.off('agent:create', handler);
  });

  it('calls once() handler only one time', () => {
    const handler = jest.fn();
    hooks.once('thread:delete', handler);

    hooks.emit('thread:delete', { id: 't1' });
    hooks.emit('thread:delete', { id: 't1' });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('off() removes a listener', () => {
    const handler = jest.fn();
    hooks.on('tool:delete', handler);
    hooks.off('tool:delete', handler);

    hooks.emit('tool:delete', { id: 'tool-1' });
    expect(handler).not.toHaveBeenCalled();
    expect(hooks.listenerCount('tool:delete')).toBe(0);
  });
});
