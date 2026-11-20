const complete = jest.fn();

jest.mock('@server/services/ProviderChatService', () => ({
  providerChatService: { complete: (...args: unknown[]) => complete(...args) },
}));

jest.mock('@server/services/summary/utilityConcurrency', () => ({
  withLocalProviderSlot: (fn: () => unknown) => fn(),
}));

import { generateUtilityText } from '@server/services/summary/generateUtilityText';
import type { ResolvedUtilityModel } from '@server/services/summary/UtilityModelResolver';

const model: ResolvedUtilityModel = {
  providerId: 'test-provider',
  modelId: 'test-model',
  credentialId: null,
  isLocal: false,
  maxInputChars: 60_000,
  timeoutMs: 60_000,
  source: 'own-model',
};

describe('generateUtilityText — caller abort signal', () => {
  beforeEach(() => complete.mockReset());

  it('an already-aborted signal rejects with an AbortError and never calls the provider', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateUtilityText(model, { userMessage: 'x', signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('aborting mid-call cancels the provider request and rejects as an abort, not a timeout', async () => {
    complete.mockImplementation(
      (_agent: unknown, _messages: unknown, _tools: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('request canceled')));
        })
    );
    const controller = new AbortController();
    const pending = generateUtilityText(model, { userMessage: 'x', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const opts = complete.mock.calls[0]![3] as { signal: AbortSignal };
    expect(opts.signal.aborted).toBe(true);
  });

  it('without a signal, behavior is unchanged', async () => {
    complete.mockResolvedValue({ reply: 'ok' });
    await expect(generateUtilityText(model, { userMessage: 'x' })).resolves.toBe('ok');
  });
});
