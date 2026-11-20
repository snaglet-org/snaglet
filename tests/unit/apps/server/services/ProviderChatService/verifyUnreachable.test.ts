/**
 * Test connection against a provider that cannot be reached (offline, a wrong
 * address, a local server that is not running) is a failed test that says
 * why, not a server error: Get started and Providers show the reason and the
 * saved key is marked failed.
 */
import { describe, expect, it, jest } from '@jest/globals';

const mockVerify = jest.fn<() => Promise<{ valid: boolean; message: string }>>();
jest.mock('@server/services/ProviderChatService/providers/registry', () => ({
  PROVIDER_REGISTRY: { deepseek: { verify: mockVerify, chat: jest.fn() } },
}));

import { providerChatService } from '@server/services/ProviderChatService';

describe('providerChatService.verify when the provider cannot be reached', () => {
  it('reports a failed test with the network cause', async () => {
    mockVerify.mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    );
    const result = await providerChatService.verify('deepseek', 'test-key-0000');
    expect(result.valid).toBe(false);
    expect(result.message).toContain('Could not reach the provider (ECONNREFUSED)');
  });

  it('falls back to the error message when there is no cause', async () => {
    mockVerify.mockRejectedValueOnce(new Error('socket hang up'));
    const result = await providerChatService.verify('deepseek', 'test-key-0000');
    expect(result).toMatchObject({ valid: false });
    expect(result.message).toContain('(socket hang up)');
  });

  it('passes a normal result through', async () => {
    mockVerify.mockResolvedValueOnce({ valid: true, message: 'Connected' });
    expect(await providerChatService.verify('deepseek', 'test-key-0000')).toEqual({
      valid: true,
      message: 'Connected',
    });
  });
});
