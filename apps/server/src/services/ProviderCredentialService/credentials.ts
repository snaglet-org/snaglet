import { randomUUID } from 'crypto';
import { UserProviderCredentials } from '@snaglet/db/tables/user_provider_credentials';
import type { UserProviderCredentialRow } from '@snaglet/db/tables/user_provider_credentials';
import { Providers } from '@snaglet/db/tables/providers';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { decrypt, encrypt } from '@server/utils/encryption';
import { CredentialDecryptError } from './errors';
import { normalizeProviderId, toSafeProviderCredential } from './normalization';
import type {
  ExportedProviderCredential,
  SafeProviderCredential,
  SaveProviderCredentialInput,
} from './types';

/**
 * Key under which the OAuth refresh token is stored inside the AES-GCM
 * `encrypted_bundle`. The refresh token is the long-lived, higher-value
 * credential (it mints new access tokens indefinitely), so it must never sit in
 * the plaintext `metadata_json` — only encrypted, alongside the short-lived
 * access token in `encrypted_secret`. OAuth credential rows never carry an MCP
 * multi-field bundle, so reusing the column for `{ refresh_token }` cannot
 * collide with `saveCredentialBundle`.
 */
const REFRESH_TOKEN_BUNDLE_KEY = 'refresh_token';

/** Encrypt a refresh token as the credential's bundle blob. */
function encryptRefreshBundle(refreshToken: string): string {
  return encrypt(JSON.stringify({ [REFRESH_TOKEN_BUNDLE_KEY]: refreshToken }));
}

/**
 * Split metadata into its non-secret part plus, when a `refresh_token` is
 * present, an encrypted bundle to hold it. Applied at every write site
 * (save / edit / rotate) so refresh tokens never reach the plaintext
 * `metadata_json`. When the incoming metadata has no `refresh_token`,
 * `encryptedBundle` is undefined so callers leave any existing bundle untouched.
 */
function peelRefreshToken(metadata: Record<string, unknown> | undefined): {
  metadata: Record<string, unknown> | undefined;
  encryptedBundle?: string;
} {
  if (!metadata || !(REFRESH_TOKEN_BUNDLE_KEY in metadata)) return { metadata };
  const { [REFRESH_TOKEN_BUNDLE_KEY]: rt, ...rest } = metadata;
  if (typeof rt === 'string' && rt.length > 0) {
    return { metadata: rest, encryptedBundle: encryptRefreshBundle(rt) };
  }
  // Present but empty/invalid → drop the key, write no bundle.
  return { metadata: rest };
}

/**
 * Read a stored OAuth refresh token. Prefers the encrypted bundle; falls back to
 * a plaintext `metadata_json.refresh_token`, which older rows still carry until
 * the backfill or the next rotation moves it. Returns null when none is stored.
 */
export function readRefreshToken(row: {
  encryptedBundle: string | null;
  metadataJson: Record<string, unknown> | null | undefined;
}): string | null {
  if (row.encryptedBundle) {
    try {
      const parsed = safeJsonParse<Record<string, unknown> | null>(
        decrypt(row.encryptedBundle),
        null
      );
      const rt = parsed?.[REFRESH_TOKEN_BUNDLE_KEY];
      if (typeof rt === 'string' && rt.length > 0) return rt;
    } catch {
      // fall through to the plaintext field
    }
  }
  const legacy = row.metadataJson?.[REFRESH_TOKEN_BUNDLE_KEY];
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : null;
}

export async function listSafeCredentials(): Promise<SafeProviderCredential[]> {
  const rows = await UserProviderCredentials.listAll();
  return rows.map((row) => toSafeProviderCredential(row));
}

export async function saveCredential(
  input: SaveProviderCredentialInput
): Promise<SafeProviderCredential> {
  const providerId = normalizeProviderId(input.providerId);
  const authTypeId = input.authTypeId;
  const authType = input.authType || 'api_key';
  const label = input.label?.trim() || `${providerId}:${authTypeId}`;

  const { metadata, encryptedBundle } = peelRefreshToken(input.metadata);

  // Checked before the insert so the new row can't count as "existing". The
  // first credential for a provider becomes its primary automatically: a
  // provider with exactly one key and no primary is never what the user
  // meant, and every routing path (resolveCredentialIdForModel, the rotation
  // UI) keys off providers.primary_credential_id. Later credentials arrive
  // unassigned ("not in rotation") and never steal an existing primary.
  const isFirstCredentialForProvider =
    (await UserProviderCredentials.findByProviderId(providerId)) === null;

  const row = await UserProviderCredentials.create({
    id: randomUUID(),
    providerId,
    authTypeId,
    authType,
    label,
    encryptedSecret: encrypt(input.secret),
    encryptedBundle,
    metadataJson: metadata,
  });

  if (isFirstCredentialForProvider) {
    // Best-effort: the credential itself saved fine, and a missing providers
    // row (e.g. an id the catalog doesn't know) must not fail the save.
    try {
      await Providers.updatePrimaryCredential(providerId, row.id);
    } catch (err) {
      logger.warn(
        `[provider-credentials] failed to set first credential ${row.id} as primary for ` +
          `${providerId}: ${getErrorMessage(err)}`
      );
    }
  }

  return toSafeProviderCredential(row);
}

export async function removeCredential(id: string): Promise<boolean> {
  return UserProviderCredentials.delete(id);
}

/**
 * Upsert a provider's single secret (the `${credential}` placeholder). One
 * credential row per provider: patch the existing row's secret, else create.
 * Used by the MCP credential form for servers needing one opaque token.
 */
export async function upsertProviderSecret(input: {
  providerId: string;
  secret: string;
  authTypeId?: string;
  authType?: string;
  label?: string;
}): Promise<SafeProviderCredential> {
  const providerId = normalizeProviderId(input.providerId);
  const existing = await UserProviderCredentials.findByProviderId(providerId);
  if (existing) {
    const row = await UserProviderCredentials.patch(existing.id, {
      encryptedSecret: encrypt(input.secret),
      ...(input.label !== undefined ? { label: input.label } : {}),
    });
    return toSafeProviderCredential(row ?? existing);
  }
  const row = await UserProviderCredentials.create({
    id: randomUUID(),
    providerId,
    authTypeId: input.authTypeId ?? `${providerId}:secret`,
    authType: input.authType ?? 'api_key',
    label: input.label?.trim() || `${providerId}:secret`,
    encryptedSecret: encrypt(input.secret),
  });
  return toSafeProviderCredential(row);
}

/**
 * Upsert a provider's multi-field credential bundle (the `${cred.field}`
 * placeholders), stored as an AES-GCM-encrypted JSON object in
 * `encrypted_bundle`. A placeholder `encrypted_secret` ('') satisfies the
 * NOT NULL column for bundle-only credentials. One row per provider.
 */
export async function saveCredentialBundle(input: {
  providerId: string;
  bundle: Record<string, string>;
  authTypeId?: string;
  authType?: string;
  label?: string;
}): Promise<SafeProviderCredential> {
  const providerId = normalizeProviderId(input.providerId);
  const encryptedBundle = encrypt(JSON.stringify(input.bundle));
  const existing = await UserProviderCredentials.findByProviderId(providerId);
  if (existing) {
    const row = await UserProviderCredentials.patch(existing.id, {
      encryptedBundle,
      ...(input.label !== undefined ? { label: input.label } : {}),
    });
    return toSafeProviderCredential(row ?? existing);
  }
  const row = await UserProviderCredentials.create({
    id: randomUUID(),
    providerId,
    authTypeId: input.authTypeId ?? `${providerId}:bundle`,
    authType: input.authType ?? 'freeform',
    label: input.label?.trim() || `${providerId}:bundle`,
    // Empty (NOT encrypt('')): satisfies the NOT NULL column without being
    // mistaken for a real single secret — `hasSecret` and the decrypt guards
    // both treat '' as "no single secret" (m2). The real data is the bundle.
    encryptedSecret: '',
    encryptedBundle,
  });
  return toSafeProviderCredential(row);
}

/**
 * Decrypted secret for one credential, or null when the row is gone or holds
 * no single secret. A database failure propagates as-is; a secret that cannot
 * be decrypted throws `CredentialDecryptError`, so callers can tell a
 * transient lookup failure from a credential that will never work.
 */
export async function getSecretByCredentialId(credentialId: string): Promise<string | null> {
  const row = await UserProviderCredentials.findById(credentialId);
  if (!row?.encryptedSecret) return null;
  try {
    return decrypt(row.encryptedSecret);
  } catch (err) {
    throw new CredentialDecryptError(credentialId, getErrorMessage(err));
  }
}

/** Id of the row `getSecretByProviderId` would read for this provider, if any. */
export async function getDefaultCredentialIdByProviderId(
  providerIdRaw: string
): Promise<string | null> {
  const row = await UserProviderCredentials.findByProviderId(normalizeProviderId(providerIdRaw));
  return row?.id ?? null;
}

export async function getSecretByProviderId(providerIdRaw: string): Promise<string | null> {
  const providerId = normalizeProviderId(providerIdRaw);
  const row = await UserProviderCredentials.findByProviderId(providerId);
  if (!row?.encryptedSecret) return null;
  return decrypt(row.encryptedSecret);
}

/**
 * Decrypt the multi-field credential bundle for a provider (the encrypted JSON
 * object behind a `freeform`/multi-field MCP credential). Returns null when no
 * bundle is stored (single-secret credentials use getSecretByProviderId).
 */
export async function getCredentialBundleByProviderId(
  providerIdRaw: string
): Promise<Record<string, string> | null> {
  const providerId = normalizeProviderId(providerIdRaw);
  const row = await UserProviderCredentials.findByProviderId(providerId);
  if (!row?.encryptedBundle) return null;
  try {
    const parsed = safeJsonParse<unknown>(decrypt(row.encryptedBundle));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export async function getFullCredentialById(
  credentialId: string
): Promise<UserProviderCredentialRow | null> {
  const row = await UserProviderCredentials.findById(credentialId);
  if (!row) return null;
  // Re-inject the decrypted refresh token into metadata so downstream OAuth
  // readers (e.g. chatCodex, the /test verify route) see it where they always
  // did. This is in-memory only — the DB keeps the refresh token encrypted.
  const refreshToken = readRefreshToken(row);
  return {
    ...row,
    // Bundle-only credentials store '' as the secret placeholder — don't decrypt it.
    encryptedSecret: row.encryptedSecret ? decrypt(row.encryptedSecret) : '',
    metadataJson: refreshToken
      ? { ...(row.metadataJson ?? {}), [REFRESH_TOKEN_BUNDLE_KEY]: refreshToken }
      : (row.metadataJson ?? {}),
  };
}

export async function getSafeCredentialById(id: string): Promise<SafeProviderCredential | null> {
  const row = await UserProviderCredentials.findById(id);
  if (!row) return null;
  return toSafeProviderCredential(row);
}

export async function exportCredentialById(id: string): Promise<ExportedProviderCredential | null> {
  const row = await UserProviderCredentials.findById(id);
  if (!row) return null;

  // Re-inject the decrypted refresh token so the exported payload is
  // self-contained and round-trips through import (saveCredential re-encrypts it).
  const refreshToken = readRefreshToken(row);
  const metadata = refreshToken
    ? { ...(row.metadataJson ?? {}), [REFRESH_TOKEN_BUNDLE_KEY]: refreshToken }
    : (row.metadataJson ?? {});

  return {
    providerId: row.providerId,
    authTypeId: row.authTypeId,
    authType: row.authType,
    label: row.label,
    secret: row.encryptedSecret ? decrypt(row.encryptedSecret) : '',
    metadata,
  };
}

export async function editCredential(
  id: string,
  patch: { label?: string; secret?: string; metadata?: Record<string, unknown> }
): Promise<SafeProviderCredential | null> {
  const dbPatch: {
    label?: string;
    encryptedSecret?: string;
    encryptedBundle?: string | null;
    metadataJson?: Record<string, unknown>;
  } = {};
  if (patch.label !== undefined) dbPatch.label = patch.label;
  if (patch.secret !== undefined) dbPatch.encryptedSecret = encrypt(patch.secret);
  if (patch.metadata !== undefined) {
    // Peel any refresh token out of the (plaintext) metadata into the encrypted
    // bundle. No refresh_token in the edit → bundle left untouched.
    const { metadata, encryptedBundle } = peelRefreshToken(patch.metadata);
    dbPatch.metadataJson = metadata ?? {};
    if (encryptedBundle !== undefined) dbPatch.encryptedBundle = encryptedBundle;
  }

  const row = await UserProviderCredentials.patch(id, dbPatch);
  if (!row) return null;
  return toSafeProviderCredential(row);
}

export async function updateCredentialSecret(
  id: string,
  newSecret: string,
  metadataPatch: Record<string, unknown>
): Promise<void> {
  // Refresh tokens go into the encrypted bundle, never plaintext metadata.
  const { metadata, encryptedBundle } = peelRefreshToken(metadataPatch);
  await UserProviderCredentials.updateTokens(
    id,
    encrypt(newSecret),
    metadata ?? {},
    encryptedBundle
  );
}

export async function resolveCredentialIdForModel(input: {
  providerId: string;
  modelId: string;
  preferredCredentialId?: string | null;
}): Promise<string | null> {
  const providerId = normalizeProviderId(input.providerId);
  const modelId = input.modelId?.trim();
  if (!providerId || !modelId) return null;

  const preferredCredentialId = input.preferredCredentialId?.trim() ?? null;
  if (preferredCredentialId) {
    const preferred = await UserProviderCredentials.findById(preferredCredentialId);
    if (preferred && normalizeProviderId(preferred.providerId) === providerId) {
      return preferred.id;
    }
  }

  const provider = await Providers.findProvider(providerId);
  if (provider?.primaryCredentialId) {
    return provider.primaryCredentialId;
  }

  const providerDefault = await UserProviderCredentials.findByProviderId(providerId);
  return providerDefault?.id ?? null;
}
