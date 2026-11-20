import { ProcessShutdownCoordinator } from '@server/services/ProcessShutdownCoordinator';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ProcessShutdownCoordinator', () => {
  it('waits for database cleanup before exiting after a startup failure', async () => {
    const cleanup = deferred();
    const calls: string[] = [];
    const coordinator = new ProcessShutdownCoordinator({
      cleanup: async () => {
        calls.push('cleanup:start');
        await cleanup.promise;
        calls.push('cleanup:closed-database');
      },
      restart: () => calls.push('restart'),
      exit: (code) => calls.push(`exit:${code}`),
      onDuplicate: () => calls.push('duplicate'),
      onError: () => calls.push('error'),
    });

    const pending = coordinator.request('STARTUP_FAILURE', 'exit', 1);
    expect(calls).toEqual(['cleanup:start']);
    cleanup.resolve();
    await pending;
    expect(calls).toEqual(['cleanup:start', 'cleanup:closed-database', 'exit:1']);
  });

  it('waits for cleanup before handing a restart back to the supervisor', async () => {
    const cleanup = deferred();
    const calls: string[] = [];
    const coordinator = new ProcessShutdownCoordinator({
      cleanup: async () => {
        calls.push('cleanup:start');
        await cleanup.promise;
        calls.push('cleanup:closed-database');
      },
      restart: () => calls.push('restart'),
      exit: (code) => calls.push(`exit:${code}`),
      onDuplicate: () => calls.push('duplicate'),
      onError: () => calls.push('error'),
    });

    const pending = coordinator.request('SIGUSR2', 'restart');
    expect(calls).toEqual(['cleanup:start']);

    cleanup.resolve();
    await pending;

    expect(calls).toEqual(['cleanup:start', 'cleanup:closed-database', 'restart']);
  });

  it('coalesces duplicate signals into the same cleanup', async () => {
    const cleanup = deferred();
    const calls: string[] = [];
    const coordinator = new ProcessShutdownCoordinator({
      cleanup: async () => {
        calls.push('cleanup');
        await cleanup.promise;
      },
      restart: () => calls.push('restart'),
      exit: (code) => calls.push(`exit:${code}`),
      onDuplicate: (signal) => calls.push(`duplicate:${signal}`),
      onError: () => calls.push('error'),
    });

    const first = coordinator.request('SIGUSR2', 'restart');
    const second = coordinator.request('SIGTERM', 'exit');
    expect(first).toBe(second);
    expect(calls).toEqual(['cleanup', 'duplicate:SIGTERM']);

    cleanup.resolve();
    await first;
    expect(calls).toEqual(['cleanup', 'duplicate:SIGTERM', 'restart']);
  });

  it('fails closed instead of restarting when cleanup fails', async () => {
    const error = new Error('database close failed');
    const calls: string[] = [];
    const coordinator = new ProcessShutdownCoordinator({
      cleanup: async () => {
        throw error;
      },
      restart: () => calls.push('restart'),
      exit: (code) => calls.push(`exit:${code}`),
      onDuplicate: () => calls.push('duplicate'),
      onError: (signal, received) => {
        expect(signal).toBe('SIGUSR2');
        expect(received).toBe(error);
        calls.push('error');
      },
    });

    await coordinator.request('SIGUSR2', 'restart');

    expect(calls).toEqual(['error', 'exit:1']);
  });
});
