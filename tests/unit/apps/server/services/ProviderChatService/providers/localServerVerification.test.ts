import { verifyOllama } from '@server/services/ProviderChatService/providers/ollama';
import { verifyLmStudio } from '@server/services/ProviderChatService/providers/lm-studio';

describe.each([
  { name: 'Ollama', env: 'SNAGLET_OLLAMA_URL', verify: verifyOllama, path: '/api/tags' },
  { name: 'LM Studio', env: 'SNAGLET_LM_STUDIO_URL', verify: verifyLmStudio, path: '/v1/models' },
])('$name connection verification', ({ name, env, verify, path }) => {
  const original = process.env[env];
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    process.env[env] = 'http://localhost:19999';
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (original === undefined) delete process.env[env];
    else process.env[env] = original;
  });

  it('checks the configured endpoint without credentials and with an 8 second deadline', async () => {
    const signal = new AbortController().signal;
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    const cancel = jest.fn().mockResolvedValue(undefined);
    fetchMock.mockResolvedValue({ ok: true, body: { cancel } });
    await expect(verify('')).resolves.toEqual({ valid: true, message: 'Connected successfully' });
    expect(fetchMock).toHaveBeenCalledWith(`http://localhost:19999${path}`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    expect(timeout).toHaveBeenCalledWith(8_000);
    expect(cancel).toHaveBeenCalled();
  });

  it.each([new TypeError('fetch failed'), new DOMException('Timeout', 'TimeoutError')])(
    'turns refusal or timeout into actionable connection feedback',
    async (error) => {
      fetchMock.mockRejectedValue(error);
      const result = await verify('');
      expect(result.valid).toBe(false);
      expect(result.message).toContain(`Start the ${name} server`);
      expect(result.message).toContain(env);
      expect(result.message).toContain('No API key is needed');
    }
  );

  it('reports an HTTP failure without throwing or asking for a local API key', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    const result = await verify('');
    expect(result.valid).toBe(false);
    expect(result.message).toContain('HTTP 503');
    expect(result.message).toContain(env);
  });
});
