/**
 * Tests for the Responses-API error extractors.
 *
 * These guard the user-facing failure messages: a codex/copilot request that
 * fails must surface the backend's real reason (model rejected, context length,
 * validation error), never a bare "Bad Request" or "Responses stream error".
 */

// The module pulls in server-config-bound imports at load; stub them so only
// the pure extractor functions are exercised here.
jest.mock('@server/services/ToolService/ToolFormatService', () => ({
  getToolParametersSchema: () => ({}),
}));
jest.mock('@server/config/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('@server/services/ProviderChatService/shared', () => ({
  logProviderPayload: jest.fn(),
  parseToolInputJson: jest.fn(() => ({})),
}));

import {
  extractResponsesErrorReason,
  extractStreamErrorReason,
} from '@server/services/ProviderChatService/providers/shared/responses-api';

describe('extractResponsesErrorReason', () => {
  it('returns the OpenAI-shape error.message', () => {
    const body = JSON.stringify({ error: { message: 'model not supported', code: 'bad_model' } });
    expect(extractResponsesErrorReason(body)).toBe('model not supported');
  });

  it('returns a string detail (ChatGPT/Codex FastAPI shape)', () => {
    const body = JSON.stringify({ detail: 'Your account is not provisioned' });
    expect(extractResponsesErrorReason(body)).toBe('Your account is not provisioned');
  });

  it('keeps the raw body when detail is the generic "Bad Request"', () => {
    const out = extractResponsesErrorReason(JSON.stringify({ detail: 'Bad Request' }));
    expect(out).toContain('Bad Request');
    // The surrounding JSON is preserved so the bare detail does not hide context.
    expect(out).toContain('detail');
  });

  it('flattens FastAPI validation arrays into loc: msg pairs', () => {
    const body = JSON.stringify({
      detail: [{ loc: ['body', 'input'], msg: 'field required', type: 'value_error' }],
    });
    const out = extractResponsesErrorReason(body);
    expect(out).toContain('body.input');
    expect(out).toContain('field required');
  });

  it('returns a snippet for non-JSON bodies (HTML gateway pages)', () => {
    expect(extractResponsesErrorReason('<html>502 Bad Gateway</html>')).toContain('502');
  });

  it('returns an empty string for an empty body', () => {
    expect(extractResponsesErrorReason('')).toBe('');
    expect(extractResponsesErrorReason('   ')).toBe('');
  });
});

describe('extractStreamErrorReason', () => {
  it('formats message with code and param', () => {
    const out = extractStreamErrorReason(
      {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: 'Your input exceeds the context window of this model.',
        param: 'input',
      },
      'Responses stream error'
    );
    expect(out).toContain('Your input exceeds the context window');
    expect(out).toContain('(context_length_exceeded)');
    expect(out).toContain('[param: input]');
  });

  it('falls back to a JSON snippet when message and code are absent', () => {
    const out = extractStreamErrorReason({ foo: 'bar' }, 'Responses stream error');
    expect(out).toContain('Responses stream error');
    expect(out).toContain('foo');
  });

  it('returns the fallback for a missing event', () => {
    expect(extractStreamErrorReason(undefined, 'fallback msg')).toBe('fallback msg');
  });
});
