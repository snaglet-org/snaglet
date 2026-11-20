/**
 * Key-prefix guidance — "wrong card" detection. When verification fails and the
 * key's prefix belongs to a different known provider, we point the user at the
 * right card. These tests pin the detection map, the exact enriched message,
 * and the guards that stop false positives on the shared `sk-` prefix.
 *
 * The map has no `gsk_` → Groq entry (the "Groq/Grok trap"): Groq is not in the
 * shipped catalog, so `gsk_` is just an unrecognized prefix — pinned below,
 * since naming a card the user cannot open would be worse than staying quiet.
 */
import { describe, expect, it } from '@jest/globals';
import {
  detectKeyProvider,
  keyPrefixHint,
  enrichVerifyFailureMessage,
} from '@server/services/ProviderChatService/keyPrefixHint';

describe('detectKeyProvider', () => {
  it('maps distinctive prefixes to their provider', () => {
    expect(detectKeyProvider('xai-abc123')?.providerId).toBe('xai');
    expect(detectKeyProvider('sk-ant-abc123')?.providerId).toBe('anthropic');
    expect(detectKeyProvider('sk-abc123')?.providerId).toBe('openai');
  });

  it('prefers the most specific prefix (sk-ant- over sk-)', () => {
    expect(detectKeyProvider('sk-ant-api03-xyz')?.providerId).toBe('anthropic');
  });

  it('does not recognize the Groq prefix', () => {
    expect(detectKeyProvider('gsk_abc123')).toBeNull();
  });

  it('returns null for an unrecognized or empty key', () => {
    expect(detectKeyProvider('nope-123')).toBeNull();
    expect(detectKeyProvider('   ')).toBeNull();
    expect(detectKeyProvider('')).toBeNull();
  });
});

describe('keyPrefixHint', () => {
  it('names the mismatch: Anthropic card + xai- key', () => {
    expect(keyPrefixHint('anthropic', 'xai-abcdef')).toBe(
      'this looks like an xAI (Grok) key; Anthropic keys start with sk-ant-. Try the xAI provider card.'
    );
  });

  it('names the reverse: xAI card + sk-ant- key', () => {
    expect(keyPrefixHint('xai', 'sk-ant-abcdef')).toBe(
      'this looks like an Anthropic key; xAI (Grok) keys start with xai-. Try the Anthropic provider card.'
    );
  });

  it('hints even when the card provider has no distinctive prefix of its own', () => {
    // Mistral has no entry in the map, so no "X keys start with Y" clause.
    expect(keyPrefixHint('mistral', 'xai-abcdef')).toBe(
      'this looks like an xAI (Grok) key. Try the xAI provider card.'
    );
  });

  it('returns null when the key belongs to the card being verified', () => {
    expect(keyPrefixHint('xai', 'xai-abcdef')).toBeNull();
    expect(keyPrefixHint('anthropic', 'sk-ant-abc')).toBeNull();
  });

  it('does not second-guess a plausibly-correct sk- key on an sk- card (DeepSeek)', () => {
    // sk- is shared (OpenAI, DeepSeek, …); DeepSeek has no distinctive prefix,
    // so a sk- key there is plausibly valid — no hint.
    expect(keyPrefixHint('deepseek', 'sk-abcdef')).toBeNull();
  });

  it('flags a bare sk- key on a card with a distinctive prefix (xAI)', () => {
    expect(keyPrefixHint('xai', 'sk-abcdef')).toBe(
      'this looks like an OpenAI-family key; xAI (Grok) keys start with xai-. Try the OpenAI provider card.'
    );
  });

  it('stays silent on a key for an unsupported provider rather than naming a card that does not exist', () => {
    expect(keyPrefixHint('xai', 'gsk_abcdef')).toBeNull();
    expect(keyPrefixHint('anthropic', 'gsk_abcdef')).toBeNull();
  });

  it('returns null for an unrecognized key', () => {
    expect(keyPrefixHint('xai', 'totally-unknown-key')).toBeNull();
  });
});

describe('enrichVerifyFailureMessage', () => {
  it('appends the hint to the upstream message', () => {
    expect(enrichVerifyFailureMessage('anthropic', 'xai-abc', 'Invalid API Key')).toBe(
      'Invalid API Key — this looks like an xAI (Grok) key; Anthropic keys start with sk-ant-. Try the xAI provider card.'
    );
  });

  it('falls back to "Verification failed" when the upstream message is empty', () => {
    expect(enrichVerifyFailureMessage('anthropic', 'xai-abc', '')).toBe(
      'Verification failed — this looks like an xAI (Grok) key; Anthropic keys start with sk-ant-. Try the xAI provider card.'
    );
  });

  it('leaves the message untouched when there is nothing to add', () => {
    expect(
      enrichVerifyFailureMessage('anthropic', 'sk-ant-valid', 'Authentication failed (401)')
    ).toBe('Authentication failed (401)');
  });
});
