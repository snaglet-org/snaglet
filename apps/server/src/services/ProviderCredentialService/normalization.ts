import type { UserProviderCredentialRow } from '@snaglet/db/tables/user_provider_credentials';
import type { SafeProviderCredential } from './types';

/** Map alias ids to their canonical provider id; unknown ids pass through. */
export function normalizeProviderId(providerId: string): string {
  const normalized = providerId.toLowerCase().trim();
  if (normalized === 'gemini') return 'google';
  if (normalized === 'github-copilot') return 'copilot';
  return normalized;
}

export function toSafeProviderCredential(row: UserProviderCredentialRow): SafeProviderCredential {
  return {
    id: row.id,
    providerId: row.providerId,
    authTypeId: row.authTypeId || row.authType,
    authType: row.authType,
    label: row.label,
    hasSecret: !!row.encryptedSecret,
    updatedAt: row.updatedAt,
    verificationStatus: row.verificationStatus ?? 'untested',
  };
}
