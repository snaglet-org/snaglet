import {
  transientProviderRetryDelayMs,
  waitForTransientProviderRetry,
} from '@server/services/SocketService/handlers/chatPhases/providerRetryPolicy';

describe('provider retry backoff', () => {
  test('uses a short 2-3 second jittered delay', () => {
    expect(transientProviderRetryDelayMs(() => 0)).toBe(2_000);
    expect(transientProviderRetryDelayMs(() => 0.999)).toBe(2_999);
  });

  test('an already-aborted run does not wait for the retry timer', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(waitForTransientProviderRetry(controller.signal, 10_000)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
