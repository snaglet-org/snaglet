/**
 * Availability gating for the `apple-on-device` provider:
 * non-darwin hides it entirely; darwin-but-currently-
 * unavailable shows it DISABLED with the honest reason. Every other provider
 * is untouched — strictly additive, applied as a post-processing pass over
 * whatever `providerService.list()`/`get()` already computed.
 */
import { resolveAppleChatAvailability } from '@server/services/ProviderChatService/appleChat/appleChatResolver';
import type { Provider } from './types';

const APPLE_ON_DEVICE_ID = 'apple-on-device';

/** Apply to a `list()` result: drop the row on non-darwin, else annotate it. */
export async function gateAppleOnDeviceList(providers: Provider[]): Promise<Provider[]> {
  const index = providers.findIndex((p) => p.id === APPLE_ON_DEVICE_ID);
  if (index === -1) return providers;

  if (process.platform !== 'darwin') {
    return providers.filter((p) => p.id !== APPLE_ON_DEVICE_ID);
  }

  const gated = await gateOne(providers[index]!);
  const next = providers.slice();
  next[index] = gated;
  return next;
}

/** Apply to a `get(id)` result: null on non-darwin (hidden), else annotate it. */
export async function gateAppleOnDeviceGet(provider: Provider | null): Promise<Provider | null> {
  if (!provider || provider.id !== APPLE_ON_DEVICE_ID) return provider;
  if (process.platform !== 'darwin') return null;
  return gateOne(provider);
}

async function gateOne(provider: Provider): Promise<Provider> {
  const availability = await resolveAppleChatAvailability();
  if (availability.available) {
    return { ...provider, enabled: true, disabledReason: undefined };
  }
  return { ...provider, enabled: false, disabledReason: availability.reason ?? 'unknown' };
}
