/**
 * The context-window safety-margin table must be keyed by runtime provider
 * ids. A stale 'gemini' alias key sat here for months silently never
 * applying (the runtime id is 'google') — this pins the invariant so an
 * alias can't sneak back in.
 */

import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/integrations/google/googleWorkspace', () => ({
  verifyGoogleWorkspace: jest.fn(),
}));
jest.mock('@server/integrations/github/verifyGitHub', () => ({
  verifyGitHub: jest.fn(),
}));

import { PROVIDER_SAFETY_MARGIN_PCT } from '@server/services/ContextWindowService';
import { PROVIDER_REGISTRY } from '@server/services/ProviderChatService/providers/registry';
import { normalizeProviderId } from '@server/services/ProviderChatService/shared';

describe('PROVIDER_SAFETY_MARGIN_PCT', () => {
  it('is keyed by runtime provider ids only (no aliases)', () => {
    for (const key of Object.keys(PROVIDER_SAFETY_MARGIN_PCT)) {
      expect(normalizeProviderId(key)).toBe(key);
      expect(PROVIDER_REGISTRY[key]).toBeDefined();
    }
  });

  it("has no stale 'gemini' alias key", () => {
    expect(PROVIDER_SAFETY_MARGIN_PCT).not.toHaveProperty('gemini');
    expect(PROVIDER_SAFETY_MARGIN_PCT).toHaveProperty('google');
  });
});
