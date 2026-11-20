import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isConnectionRefused,
  quietProxyDuringBoot,
  type ConfigurableProxy,
} from './quietProxyDuringBoot';

class FakeProxy implements ConfigurableProxy {
  listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, callback: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
  }

  removeAllListeners(event: string): void {
    this.listeners.delete(event);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

const refused = (url = '/api/providers') => {
  const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const response = {
    writeHead: vi.fn(),
    end: vi.fn(),
  };
  return { error, request: { url }, response };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('quietProxyDuringBoot', () => {
  it('recognizes plain and aggregate connection-refused errors only', () => {
    expect(isConnectionRefused(Object.assign(new Error(), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(
      isConnectionRefused(
        Object.assign(new Error(), {
          errors: [Object.assign(new Error(), { code: 'ECONNREFUSED' })],
        })
      )
    ).toBe(true);
    expect(isConnectionRefused(Object.assign(new Error(), { code: 'ECONNRESET' }))).toBe(false);
  });

  it('replaces Vite noise, logs one boot notice, and closes every failed response', async () => {
    const proxy = new FakeProxy();
    const viteErrorListener = vi.fn();
    proxy.on('error', viteErrorListener);
    quietProxyDuringBoot('/api')(proxy);
    await Promise.resolve();

    const first = refused();
    const retry = refused('/api/user-profile');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    proxy.emit('error', first.error, first.request, first.response);
    proxy.emit('error', retry.error, retry.request, retry.response);

    expect(viteErrorListener).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('[proxy] backend not ready yet — /api /api/providers');
    expect(consoleError).not.toHaveBeenCalled();
    expect(first.response.writeHead).toHaveBeenCalledWith(502, {
      'Content-Type': 'text/plain',
    });
    expect(first.response.end).toHaveBeenCalledWith('backend starting');
    expect(retry.response.end).toHaveBeenCalledWith('backend starting');
  });

  it('ends an HTTP response even when headers were already sent', async () => {
    const proxy = new FakeProxy();
    quietProxyDuringBoot('/api')(proxy);
    await Promise.resolve();

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
      headersSent: true,
      writableEnded: false,
    };
    proxy.emit('error', refused().error, { url: '/api/providers' }, response);

    expect(response.writeHead).not.toHaveBeenCalled();
    expect(response.end).toHaveBeenCalledOnce();
    expect(response.end).toHaveBeenCalledWith();
  });

  it.each(['proxyRes', 'open'])(
    'reports a new outage after a successful %s event',
    async (event) => {
      const proxy = new FakeProxy();
      quietProxyDuringBoot(event === 'open' ? '/ws' : '/api')(proxy);
      await Promise.resolve();

      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const first = refused();
      const retry = refused('/api/user-profile');
      proxy.emit('error', first.error, first.request, first.response);
      proxy.emit('error', retry.error, retry.request, retry.response);
      expect(log).toHaveBeenCalledOnce();

      proxy.emit(event);
      const laterOutage = refused('/api/providers');
      proxy.emit('error', laterOutage.error, laterOutage.request, laterOutage.response);

      expect(log).toHaveBeenCalledTimes(2);
    }
  );

  it('keeps non-startup proxy failures visible and ends WebSocket upgrades', async () => {
    const proxy = new FakeProxy();
    quietProxyDuringBoot('/ws')(proxy);
    await Promise.resolve();

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
    const socket = { end: vi.fn() };
    proxy.emit('error', error, { url: '/ws' }, socket);

    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]?.[0]).toContain('[proxy] /ws error: socket reset');
    expect(socket.end).toHaveBeenCalledOnce();
  });
});
