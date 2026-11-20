/**
 * Google Workspace OAuth credential access. `getGoogleClient()` returns the one
 * Google connection per workspace (provider key 'google-workspace'; 'google' is
 * Gemini), refreshing the access token within 60 s of expiry and writing it
 * back, like resolveCodexAccessToken in providers/codex.ts.
 * `verifyGoogleWorkspace` returns a ProviderVerifyResult for
 * providerChatService.verify(); it ignores its secret and reads the DB row.
 */
import { randomUUID } from 'crypto';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { UserProviderCredentials } from '@snaglet/db/tables/user_provider_credentials';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { decrypt, encrypt } from '@server/utils/encryption';
import type {
  ProviderVerifyOptions,
  ProviderVerifyResult,
} from '@server/services/ProviderChatService/types';
import { getErrorMessage, isHttpUrl } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { issueGoogleOAuthState } from './oauthState';

const PROVIDER_KEY = 'google-workspace';
/**
 * Storage keys for the OAuth client credentials (a Google "Desktop app" Client
 * ID and Secret the user enters in Providers). They sit in
 * `user_provider_credentials` under their own provider id, because they are
 * needed before OAuth starts and the token row only exists after the callback.
 */
const CLIENT_PROVIDER_KEY = 'google-workspace-client-desktop';
const CLIENT_AUTH_TYPE_ID = 'google-workspace:client-desktop';
const CLIENT_LABEL = 'Google OAuth Client (Desktop)';
const REFRESH_THRESHOLD_MS = 60_000; // refresh if within 60 s of expiry

interface GoogleTokenMeta {
  refresh_token?: string;
  expires?: number; // unix ms
  email?: string;
}

// OAuth scopes: identity + full read/write across Calendar, Docs, Sheets, Forms, Gmail, Drive.
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
];

/** Path half of the OAuth redirect — the route registered in routes/providers.ts. */
export const GOOGLE_OAUTH_CALLBACK_PATH = '/api/providers/google-workspace/oauth/callback';

/**
 * Resolve the OAuth redirect URI at call time: the packaged sidecar's port is
 * only known at launch. Order: `API_BASE_URL` (the shell sets it to the bound
 * origin), then `http://127.0.0.1:$PORT`, else throw rather than build a
 * consent URL Google rejects. A wildcard bind host becomes loopback, the only
 * redirect Google's installed-app flow accepts.
 */
export function resolveGoogleRedirectUri(): string {
  return `${resolveServerOrigin()}${GOOGLE_OAUTH_CALLBACK_PATH}`;
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '']);

function resolveServerOrigin(): string {
  const configured = process.env.API_BASE_URL?.trim();
  if (configured && isHttpUrl(configured)) {
    const url = new URL(configured);
    if (WILDCARD_HOSTS.has(url.hostname)) url.hostname = '127.0.0.1';
    // `origin` drops any path/query the env var carried, which is what a
    // redirect URI wants — the callback path is appended by the caller.
    return url.origin;
  }

  const port = Number(process.env.PORT?.trim());
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    return `http://127.0.0.1:${port}`;
  }

  throw new Error(
    '[google-workspace] Cannot determine the OAuth redirect URI: neither API_BASE_URL ' +
      `(currently ${configured ? `"${configured}" — not a valid http(s) URL` : 'unset'}) ` +
      `nor PORT (currently ${process.env.PORT ? `"${process.env.PORT}"` : 'unset'}) ` +
      'resolves to a server origin. Set API_BASE_URL to the origin this server is ' +
      'reachable at (e.g. http://127.0.0.1:4001) and reconnect Google.'
  );
}

export interface GoogleClientCreds {
  clientId: string;
  clientSecret: string;
  source: 'db';
}

/**
 * Read the OAuth client credentials saved from the Providers UI. Returns null
 * when nothing is configured so callers can render a "configure first"
 * affordance rather than throwing.
 */
export async function getStoredClientCreds(): Promise<GoogleClientCreds | null> {
  const row = await UserProviderCredentials.findByProviderId(CLIENT_PROVIDER_KEY);
  if (!row) return null;

  const meta = (row.metadataJson ?? {}) as { client_id?: string };
  const clientId = typeof meta.client_id === 'string' ? meta.client_id : '';

  let clientSecret = '';
  try {
    clientSecret = decrypt(row.encryptedSecret);
  } catch (err) {
    // A row that exists but cannot be decrypted is not "not configured": the
    // Client ID is plaintext metadata, so the row looks healthy while every read
    // fails. A different CREDENTIAL_ENCRYPTION_KEY wrote it (a second checkout's
    // .env, or a packaged app's ~/.snaglet/credential.key). Say so, with the fix.
    logger.error(
      `[google-workspace] Stored OAuth client secret could not be decrypted ` +
        `(${getErrorMessage(err)}). The credential row exists but was encrypted with a ` +
        `different CREDENTIAL_ENCRYPTION_KEY than this server is using. Re-enter the ` +
        `Client ID and Secret in Dashboard → Settings → Providers → Google to rewrite it ` +
        `under the current key.`
    );
    return null;
  }

  if (!clientId || !clientSecret) {
    logger.error(
      `[google-workspace] Stored OAuth client row is incomplete ` +
        `(client_id ${clientId ? 'present' : 'MISSING'}, secret ${clientSecret ? 'present' : 'EMPTY'}). ` +
        `Re-enter both values in Dashboard → Settings → Providers → Google.`
    );
    return null;
  }

  return { clientId, clientSecret, source: 'db' };
}

/**
 * Upsert the OAuth client credentials. Drops any prior
 * row and writes a fresh one so storage stays single-tenant per
 * workspace.
 */
export async function setStoredClientCreds(input: {
  clientId: string;
  clientSecret: string;
}): Promise<void> {
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  if (!clientId || !clientSecret) {
    throw new Error('[google-workspace] clientId and clientSecret are required');
  }
  const existing = await UserProviderCredentials.findByProviderId(CLIENT_PROVIDER_KEY);
  if (existing) {
    await UserProviderCredentials.delete(existing.id);
  }
  await UserProviderCredentials.create({
    id: randomUUID(),
    providerId: CLIENT_PROVIDER_KEY,
    authType: 'api_key',
    authTypeId: CLIENT_AUTH_TYPE_ID,
    label: CLIENT_LABEL,
    encryptedSecret: encrypt(clientSecret),
    metadataJson: { client_id: clientId },
  });
}

/** Remove the stored OAuth client credentials (forces re-entry). */
export async function clearStoredClientCreds(): Promise<void> {
  const existing = await UserProviderCredentials.findByProviderId(CLIENT_PROVIDER_KEY);
  if (existing) {
    await UserProviderCredentials.delete(existing.id);
  }
}

async function requireClientCreds(): Promise<{ clientId: string; clientSecret: string }> {
  const creds = await getStoredClientCreds();
  if (!creds) {
    throw new Error(
      '[google-workspace] Desktop app OAuth client not configured. Open Dashboard → Settings → ' +
        'Providers → Integrations → Google and enter your Client ID and Secret.'
    );
  }
  return { clientId: creds.clientId, clientSecret: creds.clientSecret };
}

/**
 * Build the Google consent-screen URL the Providers-page Connect button opens.
 * `access_type=offline` + `prompt=consent` guarantees a refresh_token.
 *
 * `redirectUri` is passed in rather than resolved here so the caller can pin
 * the same string into the state ledger and replay it at token-exchange time —
 * Google compares the two and answers `redirect_uri_mismatch` if they differ.
 */
async function buildGoogleAuthUrl(state: string, redirectUri: string): Promise<string> {
  const { clientId, clientSecret } = await requireClientCreds();
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    state,
  });
}

/**
 * Mint the consent URL and the state that guards its callback in one step, so
 * a caller cannot build one without the other. The redirect URI is resolved
 * once and pinned to the state.
 */
export async function startGoogleOAuth(): Promise<{ url: string; state: string }> {
  const redirectUri = resolveGoogleRedirectUri();
  const state = issueGoogleOAuthState(redirectUri);
  const url = await buildGoogleAuthUrl(state, redirectUri);
  return { url, state };
}

export interface GoogleExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expires: number; // unix ms
  accountEmail?: string;
}

/**
 * Exchange an authorization code for tokens and resolve the account email.
 *
 * `redirectUri` must be the exact string that was in the authorization
 * request — Google re-checks it here. Callers pass the value pinned to the
 * OAuth state; it defaults to a fresh resolution only for direct/scripted use.
 */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string = resolveGoogleRedirectUri()
): Promise<GoogleExchangeResult> {
  const { clientId, clientSecret } = await requireClientCreds();
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.access_token) {
    throw new Error('[google-workspace] Token exchange returned no access_token');
  }
  oauth2Client.setCredentials(tokens);

  let accountEmail: string | undefined;
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    accountEmail = data.email ?? undefined;
  } catch {
    // non-fatal — email is a nicety for the label
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? undefined,
    expires: tokens.expiry_date ?? Date.now() + 3_600_000,
    accountEmail,
  };
}

/**
 * Return a fully-authed Google OAuth2Client for the workspace.
 * Refreshes the access token automatically if near expiry.
 */
export async function getGoogleClient(): Promise<OAuth2Client> {
  const row = await UserProviderCredentials.findByProviderId(PROVIDER_KEY);
  if (!row) {
    throw new Error(
      '[google-workspace] No credential found. Connect Google in Dashboard → Providers.'
    );
  }

  let accessToken = decrypt(row.encryptedSecret);
  const meta = (row.metadataJson ?? {}) as GoogleTokenMeta;
  const { clientId, clientSecret } = await requireClientCreds();
  // Refresh token lives encrypted in the bundle (legacy rows fall back to
  // plaintext metadata until the next rotation re-encrypts it).
  const refreshToken = providerCredentialService.readRefreshToken(row) ?? undefined;
  const expiresMs = meta.expires ? Number(meta.expires) : 0;

  const needsRefresh =
    !!refreshToken && (!expiresMs || Date.now() >= expiresMs - REFRESH_THRESHOLD_MS);

  if (needsRefresh) {
    try {
      const helper = new google.auth.OAuth2(clientId, clientSecret);
      helper.setCredentials({ refresh_token: refreshToken });
      const { credentials } = await helper.refreshAccessToken();
      if (credentials.access_token) {
        accessToken = credentials.access_token;
        const patch: Record<string, unknown> = {
          expires: credentials.expiry_date ?? Date.now() + 3_600_000,
        };
        if (credentials.refresh_token) patch.refresh_token = credentials.refresh_token;
        // fire-and-forget — don't block the tool call on a DB write. updateSecret
        // encrypts the access token and peels the refresh token into the bundle.
        providerCredentialService.updateSecret(row.id, accessToken, patch).catch((err) => {
          logger.warn(
            `[google-workspace] failed to persist refreshed token: ${getErrorMessage(err)}`
          );
        });
      }
    } catch {
      // swallow — keep the existing token and let the downstream API call surface any auth error
    }
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiresMs || undefined,
  });
  return oauth2Client;
}

/**
 * Verifier hook — wired into providerChatService.verify() for 'google-workspace'.
 * The `_secret` arg is not used — tokens come from DB, not the caller.
 */
export async function verifyGoogleWorkspace(
  _secret: string,
  _options?: ProviderVerifyOptions
): Promise<ProviderVerifyResult> {
  try {
    const auth = await getGoogleClient();
    const oauth2 = google.oauth2({ version: 'v2', auth });
    const { data } = await oauth2.userinfo.get();
    const email = data.email ?? 'Google account';
    return { valid: true, message: `Connected as ${email}` };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { valid: false, message: msg };
  }
}
