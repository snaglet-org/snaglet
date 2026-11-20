/**
 * Provider registry coverage: every provider the catalog seeds as a
 * selectable LLM must be fully wired (chat + verify) in the runtime registry,
 * and alias ids must normalize to registered entries. Keyed lists live in one
 * place; these tests keep the declared-elsewhere spots (seed, margins) honest.
 */

import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/integrations/google/googleWorkspace', () => ({
  verifyGoogleWorkspace: jest.fn(),
}));
jest.mock('@server/integrations/github/verifyGitHub', () => ({
  verifyGitHub: jest.fn(),
}));

import { PROVIDER_REGISTRY } from '@server/services/ProviderChatService/providers/registry';
import { normalizeProviderId } from '@server/services/ProviderChatService/shared';

/** LLM providers seeded selectable by migrations/seeds/ (provider catalog). */
const SEEDED_LLM_PROVIDERS = [
  'anthropic',
  'openai',
  'codex',
  'copilot',
  'google',
  'mistral',
  'deepseek',
  'xai',
  'together',
  'lm-studio',
  'ollama',
  'apple-on-device',
];

describe('PROVIDER_REGISTRY', () => {
  it.each(SEEDED_LLM_PROVIDERS)('%s is chat-capable and verifiable', (id) => {
    const entry = PROVIDER_REGISTRY[id];
    expect(entry).toBeDefined();
    expect(typeof entry!.chat).toBe('function');
    expect(typeof entry!.verify).toBe('function');
  });

  it('verify-only integration providers have no chat surface', () => {
    for (const id of ['google-workspace', 'github']) {
      const entry = PROVIDER_REGISTRY[id];
      expect(entry).toBeDefined();
      expect(entry!.chat).toBeUndefined();
      expect(typeof entry!.verify).toBe('function');
    }
  });

  it('alias ids normalize to registered providers', () => {
    expect(normalizeProviderId('gemini')).toBe('google');
    expect(normalizeProviderId('github-copilot')).toBe('copilot');
    expect(normalizeProviderId('Anthropic ')).toBe('anthropic');
    for (const alias of ['gemini', 'github-copilot']) {
      expect(PROVIDER_REGISTRY[normalizeProviderId(alias)]).toBeDefined();
    }
  });

  it('unknown ids pass through normalization unchanged (forward compat)', () => {
    expect(normalizeProviderId('my-local-proxy')).toBe('my-local-proxy');
    expect(PROVIDER_REGISTRY['my-local-proxy']).toBeUndefined();
  });

  it('DeepSeek/xAI env fallbacks follow the <PROVIDER>_API_KEY convention (no SNAGLET_ prefix)', () => {
    expect(PROVIDER_REGISTRY.deepseek.envSecretVars).toEqual(['DEEPSEEK_API_KEY']);
    expect(PROVIDER_REGISTRY.xai.envSecretVars).toEqual(['XAI_API_KEY']);
    for (const id of ['deepseek', 'xai']) {
      for (const envVar of PROVIDER_REGISTRY[id].envSecretVars ?? []) {
        expect(envVar.startsWith('SNAGLET_')).toBe(false);
      }
    }
  });

  it('ids are stable and boring — no alias remap for deepseek/xai', () => {
    expect(normalizeProviderId('deepseek')).toBe('deepseek');
    expect(normalizeProviderId('xai')).toBe('xai');
  });

  it('has no groq registry entry, so nothing can chat or verify on it', () => {
    // Not in the shipped catalog. `normalizeProviderId` still
    // passes the id through (forward-compat for unknown ids), but the registry
    // has no entry, so ProviderChatService refuses it like any other stranger.
    expect(normalizeProviderId('groq')).toBe('groq');
    expect(PROVIDER_REGISTRY.groq).toBeUndefined();
  });
});
