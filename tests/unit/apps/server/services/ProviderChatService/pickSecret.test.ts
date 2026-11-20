const getSecretById = jest.fn();
const getSecret = jest.fn();

jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: {
    getSecretById: (...args: unknown[]) => getSecretById(...args),
    getSecret: (...args: unknown[]) => getSecret(...args),
  },
}));

import type { SnagletAgent } from '@server/services/AgentService';
import { pickSecret } from '@server/services/ProviderChatService/shared';

function agent(credentialId: string | null): SnagletAgent {
  return {
    provider: 'codex',
    credentialId,
  } as SnagletAgent;
}

describe('pickSecret — pinned credentials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSecretById.mockResolvedValue(null);
    getSecret.mockResolvedValue('provider-default-secret');
  });

  it('uses the exact pinned credential', async () => {
    getSecretById.mockResolvedValue('selected-secret');

    await expect(pickSecret(agent('cred-selected'))).resolves.toBe('selected-secret');
    expect(getSecretById).toHaveBeenCalledWith('cred-selected');
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('does not fall back when the pinned credential is missing at request time', async () => {
    await expect(pickSecret(agent('cred-deleted'))).resolves.toBe('');
    expect(getSecret).not.toHaveBeenCalled();
  });
});
