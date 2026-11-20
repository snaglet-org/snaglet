import type { MetadataField, ProviderAuthType } from './types';

// Keyed by auth type ID. Add entries whenever an auth type needs more than one
// credential value. The first field's key is treated as the primary secret and
// additional values are stored in metadata JSON.
const METADATA_FIELDS: Record<string, MetadataField[]> = {
  'codex:codex-subscription': [
    {
      key: 'access_token',
      label: 'Access Token',
      placeholder: 'access_token value',
      inputType: 'password',
    },
    {
      key: 'refresh_token',
      label: 'Refresh Token',
      placeholder: 'refresh_token value',
      inputType: 'password',
    },
    {
      key: 'account_id',
      label: 'Account ID',
      placeholder: 'account_id value',
      inputType: 'text',
    },
  ],
  // Google Workspace OAuth. Primary secret = access_token (encrypted_secret); the
  // refresh_token is encrypted into the credential bundle (not plaintext metadata),
  // and `expires` lives in metadata JSON. getGoogleClient() reads these and
  // refreshes near-expiry tokens via the Google token endpoint (Codex pattern).
  // Tokens are written by the OAuth callback, not by hand. The refresh_token field
  // below is an input affordance only — ProviderCredentialService encrypts it.
  'google-workspace:oauth': [
    {
      key: 'access_token',
      label: 'Access Token',
      placeholder: 'set automatically by OAuth',
      inputType: 'password',
    },
    {
      key: 'refresh_token',
      label: 'Refresh Token',
      placeholder: 'set automatically by OAuth',
      inputType: 'password',
    },
    {
      key: 'expires',
      label: 'Token Expiry (epoch ms)',
      placeholder: 'set automatically by OAuth',
      inputType: 'text',
    },
    {
      key: 'account_email',
      label: 'Google Account Email',
      placeholder: 'set automatically by OAuth',
      inputType: 'text',
    },
  ],
};

export function withMetadataFields(authType: ProviderAuthType): ProviderAuthType {
  const fields = METADATA_FIELDS[authType.id];
  return fields ? { ...authType, metadataFields: fields } : authType;
}
