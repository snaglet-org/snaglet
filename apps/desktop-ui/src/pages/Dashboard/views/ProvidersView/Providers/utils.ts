import type { MetadataField, Provider, ProviderAuthType } from '@desktop/utils/api';
import { isRecord, safeJsonParse } from '@snaglet/shared/utils';
import type { CredentialDraft } from './types';

export function isMultiField(
  authType: ProviderAuthType | undefined
): authType is ProviderAuthType & { metadataFields: MetadataField[] } {
  return (authType?.metadataFields?.length ?? 0) > 0;
}

export function resolveSecret(
  draft: CredentialDraft,
  authType: ProviderAuthType | undefined
): string {
  if (isMultiField(authType)) {
    return (draft.metadata[authType.metadataFields[0].key] ?? '').trim();
  }
  return draft.secret.trim();
}

export function resolveMetadata(
  draft: CredentialDraft,
  authType: ProviderAuthType | undefined
): Record<string, unknown> | undefined {
  if (!isMultiField(authType)) return undefined;
  const result: Record<string, unknown> = {};
  for (const field of authType.metadataFields) {
    result[field.key] = (draft.metadata[field.key] ?? '').trim();
  }
  return result;
}

/**
 * Parse a pasted credential object into metadata fields. Accepts the flat
 * shape (`{ "access_token": … }`) and the Codex CLI `auth.json` shape, which
 * nests the same keys under `tokens`; a top-level value wins over a nested one.
 */
export function parseJsonPaste(
  json: string,
  fields: MetadataField[]
): { metadata: Record<string, string>; error: string | null } {
  const parsed = safeJsonParse<unknown>(json);
  if (parsed === undefined) {
    return { metadata: {}, error: 'Invalid JSON' };
  }
  if (!isRecord(parsed)) {
    return { metadata: {}, error: 'Must be a JSON object' };
  }
  const nested: Record<string, unknown> = isRecord(parsed.tokens) ? parsed.tokens : {};

  const metadata: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of fields) {
    const val = parsed[field.key] ?? nested[field.key];
    if (val === undefined || val === null || val === '') {
      missing.push(field.key);
    } else {
      metadata[field.key] = String(val);
    }
  }
  if (missing.length > 0) {
    return { metadata, error: `Missing keys: ${missing.join(', ')}` };
  }
  return { metadata, error: null };
}

/**
 * Offline shape checks that mirror the server's format-only validation on
 * POST /providers/credentials (no expiry, signature, or entitlement checks —
 * remote authentication belongs to Test). Returns a message to show, or null when the
 * draft is well-formed enough to save.
 */
export function validateCredentialFormat(
  provider: Provider,
  authType: ProviderAuthType,
  draft: CredentialDraft
): string | null {
  if (isMultiField(authType)) {
    const missing = authType.metadataFields
      .filter((f) => !(draft.metadata[f.key] ?? '').trim())
      .map((f) => f.label);
    if (missing.length > 0) return `Missing required fields: ${missing.join(', ')}`;
  } else if (!draft.secret.trim()) {
    return 'Enter a credential value before connecting.';
  }

  if (provider.id === 'codex' && authType.id === 'codex:codex-subscription') {
    const accessToken = (draft.metadata.access_token ?? '').trim();
    if (!isJwtShaped(accessToken)) {
      return 'Access Token must be a JWT (three base64url segments with a JSON header and payload).';
    }
    for (const [key, label] of [
      ['refresh_token', 'Refresh Token'],
      ['account_id', 'Account ID'],
    ] as const) {
      if (/[\s\x00-\x1f\x7f]/.test((draft.metadata[key] ?? '').trim())) {
        return `${label} must not contain whitespace.`;
      }
    }
    return null;
  }

  if (provider.id === 'codex' && authType.type === 'api_key') {
    if (!draft.secret.trim().startsWith('sk-')) return 'Codex API keys start with "sk-".';
    if (!/^sk-[A-Za-z0-9_-]+$/.test(draft.secret.trim())) {
      return 'Codex API keys start with "sk-" and contain only letters, numbers, hyphens, or underscores.';
    }
  }

  return null;
}

/** Three base64url segments whose header and payload decode to JSON objects. */
export function isJwtShaped(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  return parts.slice(0, 2).every((segment) => isRecord(decodeBase64UrlJson(segment)));
}

function decodeBase64UrlJson(segment: string): unknown {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return safeJsonParse<unknown>(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * GitHub Copilot's OAuth auth type. Its token comes from the GitHub device
 * flow behind the Keys section's own Sign in with GitHub button, not from
 * the Add key form.
 */
const GITHUB_DEVICE_FLOW_AUTH_TYPE_ID = 'copilot:subscription';

/** The auth type a provider connects through Sign in with GitHub, if it has one. */
export function getDeviceFlowAuthType(provider: Provider): ProviderAuthType | undefined {
  return provider.authTypes.find(
    (authType) => authType.id === GITHUB_DEVICE_FLOW_AUTH_TYPE_ID && authType.type === 'oauth'
  );
}

/** The auth types the Add key form offers: all but the one Sign in with GitHub covers. */
export function getKeyAuthTypes(provider: Provider): ProviderAuthType[] {
  const deviceFlow = getDeviceFlowAuthType(provider);
  return deviceFlow
    ? provider.authTypes.filter((authType) => authType.id !== deviceFlow.id)
    : provider.authTypes;
}

export { formatShortDate as formatDate } from '@snaglet/shared/utils/dateTime';

/**
 * A provider whose every auth type is 'none' (Apple On-Device, Ollama, LM
 * Studio): there is no key to enter, so its panel shows no Keys section.
 */
export function isKeylessProvider(provider: Provider): boolean {
  return (
    provider.authTypes.length > 0 &&
    provider.authTypes.every((authType) => authType.type === 'none')
  );
}

/** These adapters connect without a credential; their endpoints are configured by environment. */
export const isLocalCredentiallessProvider = (providerId: string): boolean =>
  providerId === 'ollama' || providerId === 'lm-studio';
