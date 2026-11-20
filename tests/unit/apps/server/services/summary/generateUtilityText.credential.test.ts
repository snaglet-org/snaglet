const complete = jest.fn();

jest.mock('@server/services/ProviderChatService', () => ({
  providerChatService: { complete: (...args: unknown[]) => complete(...args) },
}));

jest.mock('@server/services/summary/utilityConcurrency', () => ({
  withLocalProviderSlot: (fn: () => unknown) => fn(),
}));

import { generateUtilityText } from '@server/services/summary/generateUtilityText';
import type { ResolvedUtilityModel } from '@server/services/summary/UtilityModelResolver';

describe('generateUtilityText — credential pinning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    complete.mockResolvedValue({ reply: 'summary text', usage: undefined });
  });

  it('passes the resolved summary credential id into the real provider-chat boundary', async () => {
    const model: ResolvedUtilityModel = {
      providerId: 'codex',
      modelId: 'gpt-5.6-luna',
      credentialId: 'cred-selected-codex',
      isLocal: false,
      maxInputChars: 100_000,
      timeoutMs: 60_000,
      source: 'thread-override',
    };

    await expect(
      generateUtilityText(model, { system: 'Summarize', userMessage: 'Thread body' })
    ).resolves.toBe('summary text');

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      provider: 'codex',
      modelId: 'gpt-5.6-luna',
      credentialId: 'cred-selected-codex',
      disableModelFallback: true,
    });
  });
});

describe('generateUtilityText — provider stop signal', () => {
  const model: ResolvedUtilityModel = {
    providerId: 'anthropic',
    modelId: 'claude-haiku',
    isLocal: false,
    maxInputChars: 100_000,
    timeoutMs: 60_000,
    source: 'thread-override',
  } as ResolvedUtilityModel;

  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['max_tokens', true],
    ['length', true],
    ['incomplete', true],
    ['end_turn', false],
    ['stop', false],
  ])('stopReason %s → truncated=%s', async (stopReason, truncated) => {
    complete.mockResolvedValue({ reply: 'text', stopReason });
    const onResult = jest.fn();
    await generateUtilityText(model, { system: 's', userMessage: 'u', onResult });
    expect(onResult).toHaveBeenCalledWith({ stopReason, truncated });
  });

  it('does not call onResult when the provider reports no stop reason (local runtimes)', async () => {
    complete.mockResolvedValue({ reply: 'text' });
    const onResult = jest.fn();
    await expect(
      generateUtilityText(model, { system: 's', userMessage: 'u', onResult })
    ).resolves.toBe('text');
    expect(onResult).not.toHaveBeenCalled();
  });
});
