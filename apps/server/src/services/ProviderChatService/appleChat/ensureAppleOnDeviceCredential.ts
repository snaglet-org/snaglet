/**
 * ensureAppleOnDeviceCredential: the Providers UI's "connected" badge and
 * `get_providers` read `user_provider_credentials`, so even a keyless provider
 * looks "not connected" until a credential row exists. When the Apple sidecar
 * is available on this machine, Snaglet creates that row itself (empty secret,
 * verificationStatus 'ok') so the provider shows connected with no user action.
 * Scoped to this one provider (not a bypass for every 'none'-auth provider);
 * chat works without the row. Best-effort, fire-and-forget from
 * runBackgroundInit: a failure just leaves the manual Connect path.
 */
import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import { UserProviderCredentials } from '@snaglet/db/tables/user_provider_credentials';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { resolveAppleChatAvailability } from './appleChatResolver';

const PROVIDER_ID = 'apple-on-device';
const AUTH_TYPE_ID = 'apple-on-device:none';

export async function ensureAppleOnDeviceCredential(): Promise<void> {
  try {
    const availability = await resolveAppleChatAvailability();
    if (!availability.available) return; // strictly additive — nothing to do

    const existing = await UserProviderCredentials.findByProviderId(PROVIDER_ID);
    if (existing) return; // user (or an earlier boot) already has one

    const credential = await providerCredentialService.save({
      providerId: PROVIDER_ID,
      authTypeId: AUTH_TYPE_ID,
      authType: 'none',
      label: 'Apple On-Device',
      secret: '',
      metadata: {},
    });
    await UserProviderCredentials.updateVerificationStatus(credential.id, 'ok');
    logger.info(
      '[apple-chat] auto-connected apple-on-device (sidecar available, no credential existed yet)'
    );
  } catch (err) {
    logger.warn(
      `[apple-chat] auto-connect credential step failed (non-fatal): ${getErrorMessage(err)}`
    );
  }
}
