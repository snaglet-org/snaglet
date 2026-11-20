import { describe, expect, it } from 'vitest';
import { voicePreviewError } from './voicePreviewError';

describe('voicePreviewError', () => {
  it('handles invalid response bodies', async () => {
    expect(
      await voicePreviewError(new Response('proxy error', { status: 502 }), 'en_US-amy-medium')
    ).toContain('502');
  });
  it('preserves specific server errors', async () => {
    expect(
      await voicePreviewError(Response.json({ error: 'Voice disabled' }, { status: 400 }), 'x')
    ).toBe('Voice disabled');
  });
  it('gives Apple-specific guidance instead of downloading Piper models', async () => {
    const result = await voicePreviewError(
      Response.json({ error: 'voice model unavailable: apple:test' }, { status: 503 }),
      'apple:test'
    );
    expect(result).toContain('System Settings');
    expect(result).not.toContain('voice:fetch');
  });
});
