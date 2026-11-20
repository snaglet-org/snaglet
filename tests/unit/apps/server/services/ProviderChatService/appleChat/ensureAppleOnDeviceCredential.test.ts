/**
 * ensureAppleOnDeviceCredential — the keyless-visibility fix. Auto-seeds an
 * empty-secret, pre-verified credential row for apple-on-device only when
 * the sidecar is confirmed available and no credential exists yet. Never
 * throws (best-effort, fire-and-forget from server startup).
 */

jest.mock('@server/services/ProviderChatService/appleChat/appleChatResolver', () => ({
  resolveAppleChatAvailability: jest.fn(),
}));
jest.mock('@snaglet/db/tables/user_provider_credentials', () => ({
  UserProviderCredentials: {
    findByProviderId: jest.fn(),
    updateVerificationStatus: jest.fn(),
  },
}));
jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: { save: jest.fn() },
}));
jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ensureAppleOnDeviceCredential } from '@server/services/ProviderChatService/appleChat/ensureAppleOnDeviceCredential';
import { resolveAppleChatAvailability } from '@server/services/ProviderChatService/appleChat/appleChatResolver';
import { UserProviderCredentials } from '@snaglet/db/tables/user_provider_credentials';
import { providerCredentialService } from '@server/services/ProviderCredentialService';

const resolveMock = resolveAppleChatAvailability as jest.Mock;
const findByProviderIdMock = UserProviderCredentials.findByProviderId as jest.Mock;
const updateVerificationStatusMock = UserProviderCredentials.updateVerificationStatus as jest.Mock;
const saveMock = providerCredentialService.save as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('ensureAppleOnDeviceCredential', () => {
  it('does nothing when the sidecar is unavailable', async () => {
    resolveMock.mockResolvedValue({ available: false, reason: 'appleIntelligenceNotEnabled' });
    await ensureAppleOnDeviceCredential();
    expect(findByProviderIdMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('does nothing when a credential already exists (never clobbers a real one)', async () => {
    resolveMock.mockResolvedValue({ available: true });
    findByProviderIdMock.mockResolvedValue({ id: 'existing-cred' });
    await ensureAppleOnDeviceCredential();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('auto-creates an empty-secret credential and marks it verified when available with none existing', async () => {
    resolveMock.mockResolvedValue({ available: true });
    findByProviderIdMock.mockResolvedValue(null);
    saveMock.mockResolvedValue({ id: 'new-cred-id' });

    await ensureAppleOnDeviceCredential();

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'apple-on-device',
        authTypeId: 'apple-on-device:none',
        authType: 'none',
        secret: '',
      })
    );
    expect(updateVerificationStatusMock).toHaveBeenCalledWith('new-cred-id', 'ok');
  });

  it('never throws — best-effort, fire-and-forget from server startup', async () => {
    resolveMock.mockRejectedValue(new Error('boom'));
    await expect(ensureAppleOnDeviceCredential()).resolves.toBeUndefined();
  });
});
