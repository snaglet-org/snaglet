import {
  ProviderRetryHandledError,
  isProviderRetryHandledError,
  isTransientProviderError,
} from '@server/services/ProviderChatService/errors';

describe('provider error classification', () => {
  test.each([
    new TypeError('terminated'),
    new Error('OpenAI 503 Service Unavailable'),
    new Error('Anthropic request failed [status=529]'),
    Object.assign(new Error('rate limited'), { status: 429 }),
    new Error('ECONNRESET'),
    new Error('socket hang up'),
  ])('recognizes transient provider failures', (error) => {
    expect(isTransientProviderError(error)).toBe(true);
  });

  test('walks undici cause chains for network codes', () => {
    const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    expect(isTransientProviderError(new TypeError('fetch failed', { cause }))).toBe(true);
  });

  test('treats a failed DNS lookup as transient (dropped Wi-Fi reports ENOTFOUND)', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), {
      code: 'ENOTFOUND',
    });
    expect(isTransientProviderError(new TypeError('fetch failed', { cause }))).toBe(true);
    expect(
      isTransientProviderError(
        new Error('Anthropic request failed: ENOTFOUND: getaddrinfo ENOTFOUND api.anthropic.com')
      )
    ).toBe(true);
  });

  test.each([
    new Error('OpenAI request failed (401): invalid api key'),
    new Error('HTTP status 403 Forbidden'),
    new Error('request failed (400): invalid_request_error'),
    new Error('maximum context length exceeded'),
    Object.assign(new Error('request aborted'), { name: 'AbortError' }),
  ])('does not retry permanent or user-abort failures', (error) => {
    expect(isTransientProviderError(error)).toBe(false);
  });

  test('marks adapter-level retry errors so the turn does not retry them again', () => {
    const error = new ProviderRetryHandledError('request failed [status=503]');
    expect(isTransientProviderError(error)).toBe(true);
    expect(isProviderRetryHandledError(error)).toBe(true);
  });
});
