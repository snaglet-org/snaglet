/**
 * appleOnDeviceGate — availability gating applied over providerService's
 * list()/get(): non-darwin hides apple-on-device entirely; darwin annotates
 * it with live enabled/disabledReason. Every other provider passes through
 * completely untouched (strictly additive).
 */

jest.mock('@server/services/ProviderChatService/appleChat/appleChatResolver', () => ({
  resolveAppleChatAvailability: jest.fn(),
}));

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  gateAppleOnDeviceList,
  gateAppleOnDeviceGet,
} from '@server/services/ProviderService/appleOnDeviceGate';
import { resolveAppleChatAvailability } from '@server/services/ProviderChatService/appleChat/appleChatResolver';
import type { Provider } from '@server/services/ProviderService/types';

const resolveMock = resolveAppleChatAvailability as jest.Mock;

const originalPlatform = process.platform;
function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
  jest.clearAllMocks();
});

function makeProvider(id: string, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    name: id,
    description: '',
    website: null,
    apiDocs: null,
    baseUrl: null,
    type: 'llm',
    enabled: true,
    sortOrder: 0,
    primaryCredentialId: null,
    authTypes: [],
    defaultMetadata: {},
    ...overrides,
  };
}

describe('gateAppleOnDeviceList', () => {
  it('passes the list through untouched when apple-on-device is not present', async () => {
    const providers = [makeProvider('anthropic')];
    await expect(gateAppleOnDeviceList(providers)).resolves.toBe(providers);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('drops apple-on-device entirely on non-darwin, leaving everything else', async () => {
    setPlatform('linux');
    const providers = [makeProvider('anthropic'), makeProvider('apple-on-device')];
    const result = await gateAppleOnDeviceList(providers);
    expect(result.map((p) => p.id)).toEqual(['anthropic']);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('darwin + available → enabled true, no disabledReason', async () => {
    setPlatform('darwin');
    resolveMock.mockResolvedValue({ available: true });
    const providers = [makeProvider('apple-on-device', { enabled: false })];
    const result = await gateAppleOnDeviceList(providers);
    expect(result[0]!.enabled).toBe(true);
    expect(result[0]!.disabledReason).toBeUndefined();
  });

  it('darwin + unavailable → enabled false with the honest reason', async () => {
    setPlatform('darwin');
    resolveMock.mockResolvedValue({ available: false, reason: 'appleIntelligenceNotEnabled' });
    const providers = [makeProvider('apple-on-device')];
    const result = await gateAppleOnDeviceList(providers);
    expect(result[0]!.enabled).toBe(false);
    expect(result[0]!.disabledReason).toBe('appleIntelligenceNotEnabled');
  });
});

describe('gateAppleOnDeviceGet', () => {
  it('passes null through untouched', async () => {
    await expect(gateAppleOnDeviceGet(null)).resolves.toBeNull();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('passes a non-apple-on-device provider through untouched', async () => {
    const provider = makeProvider('anthropic');
    await expect(gateAppleOnDeviceGet(provider)).resolves.toBe(provider);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('hides it (returns null) on non-darwin', async () => {
    setPlatform('linux');
    const provider = makeProvider('apple-on-device');
    await expect(gateAppleOnDeviceGet(provider)).resolves.toBeNull();
  });

  it('annotates darwin+unavailable with enabled:false + the reason', async () => {
    setPlatform('darwin');
    resolveMock.mockResolvedValue({ available: false, reason: 'modelNotReady' });
    const provider = makeProvider('apple-on-device');
    const result = await gateAppleOnDeviceGet(provider);
    expect(result!.enabled).toBe(false);
    expect(result!.disabledReason).toBe('modelNotReady');
  });
});
