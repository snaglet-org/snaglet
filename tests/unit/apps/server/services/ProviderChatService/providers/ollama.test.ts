import {
  normalizeOllamaBaseUrl,
  getOllamaApiRoot,
  resolveOllamaBaseUrl,
} from '@server/services/ProviderChatService/providers/ollama';

describe('normalizeOllamaBaseUrl', () => {
  it('defaults to the fixed local endpoint with /v1', () => {
    expect(normalizeOllamaBaseUrl()).toBe('http://localhost:11434/v1');
    expect(normalizeOllamaBaseUrl('')).toBe('http://localhost:11434/v1');
    expect(normalizeOllamaBaseUrl(null)).toBe('http://localhost:11434/v1');
  });

  it('appends /v1 only when missing and trims trailing slashes', () => {
    expect(normalizeOllamaBaseUrl('http://host:1234')).toBe('http://host:1234/v1');
    expect(normalizeOllamaBaseUrl('http://host:1234/')).toBe('http://host:1234/v1');
    expect(normalizeOllamaBaseUrl('http://host:1234/v1')).toBe('http://host:1234/v1');
  });
});

describe('getOllamaApiRoot', () => {
  it('strips the /v1 suffix back to the api root', () => {
    expect(getOllamaApiRoot('http://localhost:11434')).toBe('http://localhost:11434');
    expect(getOllamaApiRoot('http://host:9/v1')).toBe('http://host:9');
  });
});

describe('resolveOllamaBaseUrl', () => {
  const original = process.env.SNAGLET_OLLAMA_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.SNAGLET_OLLAMA_URL;
    else process.env.SNAGLET_OLLAMA_URL = original;
  });

  it('resolves the fixed local default at runtime when no override is set (ignores any stored DB value)', async () => {
    delete process.env.SNAGLET_OLLAMA_URL;
    await expect(resolveOllamaBaseUrl()).resolves.toBe('http://localhost:11434/v1');
  });

  it('honors the SNAGLET_OLLAMA_URL env override', async () => {
    process.env.SNAGLET_OLLAMA_URL = 'http://192.168.1.5:11434';
    await expect(resolveOllamaBaseUrl()).resolves.toBe('http://192.168.1.5:11434/v1');
  });
});
