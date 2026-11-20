/**
 * Copilot /models normalizer — the pure filter/map that turns a raw payload
 * into DiscoveredModel[]. Pins the picker/chat filters and the policy-driven
 * entitlement hint (the only per-model entitlement-ish signal the listing
 * carries — true plan entitlement is enforced only at chat time).
 *
 * The provider/credential modules are mocked so importing the normalizer never
 * pulls in the full provider chain or reaches a database.
 */
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/services/ProviderChatService/providers/copilot', () => ({
  exchangeGitHubToken: jest.fn(),
  extractBaseUrl: jest.fn(),
  COPILOT_FALLBACK_BASE_URL: 'https://api.individual.githubcopilot.com',
}));
jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: { getFullCredentialById: jest.fn() },
}));
jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: { findProvider: jest.fn() },
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { normalizeCopilotModels } from '@server/services/ProviderModelDiscoveryService/normalizers/copilot';

describe('normalizeCopilotModels', () => {
  it('marks a policy-gated model plan_blocked with a reason, and leaves enabled/absent-policy models unmarked', () => {
    const models = normalizeCopilotModels([
      {
        id: 'gpt-4.1',
        name: 'GPT-4.1',
        capabilities: { type: 'chat' },
        model_picker_enabled: true,
        policy: { state: 'enabled', terms: 'accepted' },
      },
      {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        capabilities: { type: 'chat' },
        model_picker_enabled: true,
        // No policy field at all — the common case → treated as available.
      },
      {
        id: 'o3-preview',
        name: 'o3 (preview)',
        capabilities: { type: 'chat' },
        model_picker_enabled: true,
        policy: { state: 'unconfigured', terms: 'Enable access to o3.' },
      },
    ]);

    const byId = Object.fromEntries(models.map((m) => [m.modelId, m]));
    expect(byId['gpt-4.1'].entitlement).toBeUndefined();
    expect(byId['gpt-5.4'].entitlement).toBeUndefined();
    expect(byId['o3-preview'].entitlement?.status).toBe('plan_blocked');
    expect(byId['o3-preview'].entitlement?.source).toBe('discovery');
    expect(byId['o3-preview'].entitlement?.reason).toMatch(/unconfigured/i);
  });

  it('filters out picker-disabled and non-chat entries', () => {
    const models = normalizeCopilotModels([
      { id: 'hidden', capabilities: { type: 'chat' }, model_picker_enabled: false },
      { id: 'text-embedding-3', capabilities: { type: 'embedding' }, model_picker_enabled: true },
      { id: 'kept-chat', capabilities: { type: 'chat' }, model_picker_enabled: true },
      { id: 'kept-untyped', model_picker_enabled: true }, // undefined type is kept
    ]);

    const ids = models.map((m) => m.modelId);
    expect(ids).toEqual(['kept-chat', 'kept-untyped']);
  });
});
