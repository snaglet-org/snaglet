/**
 * mcpCredentials — credential-placeholder substitution and credential-shape
 * introspection for MCP server configs. Free functions keyed on an
 * `McpServerConfig`; the only I/O is reading the anchored provider credential.
 *
 * Placeholders live in a server's `env`/`headers` string maps:
 *   - `${credential}`      → one opaque encrypted secret
 *   - `${cred.<field>}`    → one named field of the credential bundle
 */

import {
  getSecretByProviderId,
  getCredentialBundleByProviderId,
} from '@server/services/ProviderCredentialService/credentials';
import type { McpServerConfig } from './mcpTypes';

/** Single-secret placeholder: env value `${credential}` → encrypted_secret. */
const CREDENTIAL_PLACEHOLDER = '${credential}';
/** Multi-field placeholder: env value `${cred.fieldName}` → bundle[fieldName]. */
const CRED_FIELD_RE = /^\$\{cred\.([a-zA-Z0-9_]+)\}$/;

/**
 * The provider-credential key a server's credentials are stored under: its
 * provider id when set, else its own id.
 */
export function credentialKeyForConfig(config: McpServerConfig): string {
  return config.providerId ?? config.id;
}

/**
 * Substitute `${credential}` / `${cred.field}` placeholders in a string map
 * (env or headers) using the server's anchored provider credential. Returns
 * null when a referenced credential/field is missing (caller skips connect).
 */
async function substituteCreds(
  config: McpServerConfig,
  map: Record<string, string>
): Promise<Record<string, string> | null> {
  const needs = Object.values(map).some(
    (v) => v === CREDENTIAL_PLACEHOLDER || CRED_FIELD_RE.test(v)
  );
  if (!needs) return { ...map };

  // Credentials are anchored by the server's provider id when it has one
  // (builtin servers like notion/github), else by the server's own id —
  // so custom user servers need no separate `providers` row (H: the UI's
  // "1 action" flow). user_provider_credentials.provider_id has no FK.
  const credKey = credentialKeyForConfig(config);
  const single = await getSecretByProviderId(credKey);
  const bundle = await getCredentialBundleByProviderId(credKey);

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (value === CREDENTIAL_PLACEHOLDER) {
      if (!single) return null;
      out[key] = single;
      continue;
    }
    const m = CRED_FIELD_RE.exec(value);
    if (m) {
      const field = bundle?.[m[1]];
      if (field == null) return null;
      out[key] = field;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Resolve http `headers` for transport: substitute credential placeholders.
 * Returns null when a referenced credential is missing (caller skips connect),
 * mirroring resolveEnv's contract.
 */
export async function resolveHeaders(
  config: McpServerConfig
): Promise<Record<string, string> | null> {
  return substituteCreds(config, config.headers);
}

export async function resolveEnv(config: McpServerConfig): Promise<Record<string, string> | null> {
  const subbed = await substituteCreds(config, config.env);
  if (subbed === null) return null;
  return { ...(process.env as Record<string, string>), ...subbed };
}

/** True when the config's env/headers reference a credential placeholder. */
export function configRequiresCredential(config: McpServerConfig): boolean {
  const refs = [...Object.values(config.env), ...Object.values(config.headers)];
  return refs.some((v) => v === CREDENTIAL_PLACEHOLDER || CRED_FIELD_RE.test(v));
}

/**
 * Describe the credential shape a config needs, derived from its env/headers
 * placeholders — `${credential}` → one opaque secret, `${cred.field}` → one
 * named bundle field each.
 */
export function configCredentialSpec(config: McpServerConfig): {
  requiresSecret: boolean;
  bundleFields: string[];
} {
  const values = [...Object.values(config.env), ...Object.values(config.headers)];
  let requiresSecret = false;
  const fields = new Set<string>();
  for (const v of values) {
    if (v === CREDENTIAL_PLACEHOLDER) requiresSecret = true;
    const m = CRED_FIELD_RE.exec(v);
    if (m) fields.add(m[1]);
  }
  return { requiresSecret, bundleFields: [...fields] };
}
