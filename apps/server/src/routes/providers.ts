/**
 * Providers API routes
 *
 * GET    /api/providers                   — list all providers with auth types
 * GET    /api/providers/default-model     — the model an agent with none would take now
 * GET    /api/providers/credentials       — list saved credentials (redacted)
 * POST   /api/providers/credentials       — create a credential
 * DELETE /api/providers/credentials/:id  — remove a credential, re-pointing its pins
 * POST   /api/providers/credentials/:id/test — retest a saved credential (a pass refreshes the model catalog)
 * POST   /api/providers/verify            — test a credential against the live API
 * POST   /api/providers/anthropic/claude-code/login       — sync or start Claude Code sign-in
 * GET    /api/providers/anthropic/claude-code/login/:id   — poll a sign-in session
 * DELETE /api/providers/anthropic/claude-code/login/:id   — cancel a sign-in session
 * GET    /api/providers/:id               — get a single provider
 */

import { Router } from 'express';
import { providerService } from '@server/services/ProviderService';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { parseProviderCredentialInput } from '@server/services/ProviderCredentialService/format';
import {
  deleteCredentialRepointingPins,
  describePinChanges,
} from '@server/services/ProviderCredentialService/credentialPins';
import { providerChatService } from '@server/services/ProviderChatService';
import { readCodexCliAuth } from '@server/services/ProviderChatService/providers/codexCliAuth';
import {
  claudeCodeLoginService,
  syncClaudeCodeCredential,
} from '@server/services/ClaudeCodeAuthService';
import { mcpService } from '@server/services/McpService';
import { persistDiscoveredModels } from '@server/services/ProviderModelDiscoveryService/persistence';
import { suggestConnectedModel } from '@server/services/agentDefaultModel';
import { asyncHandler } from '@server/middleware';
import { sendCreated, sendOk } from '@server/utils/http';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { ProviderFallbackCredentials } from '@snaglet/db/tables/provider_fallback_credentials';
import { UserProviderCredentials } from '@snaglet/db/tables/user_provider_credentials';
import { Providers } from '@snaglet/db/tables/providers';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import {
  startGoogleOAuth,
  exchangeGoogleCode,
  getStoredClientCreds,
  setStoredClientCreds,
  clearStoredClientCreds,
} from '@server/integrations/google/googleWorkspace';
import { consumeGoogleOAuthState } from '@server/integrations/google/oauthState';

/**
 * Escape untrusted text for HTML text content. The OAuth callback renders a
 * page in the user's real browser and echoes query parameters that Google, or
 * anyone able to load the URL, supplied (e.g. `?error=<script>…`).
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The self-closing page the Google OAuth callback renders. Tauri opens consent
 * in the system browser, so the round-trip ends on a real tab that has to tell
 * the user what happened and then get out of the way.
 */
function oauthResultPage(title: string, body: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<style>body{font-family:system-ui,sans-serif;background:#0b0b0f;color:#e6e6ea;` +
    `display:flex;align-items:center;justify-content:center;height:100vh;margin:0}` +
    `.card{text-align:center;max-width:420px;padding:32px}h1{font-size:18px;margin:0 0 8px}` +
    `p{color:#9a9aa6;font-size:14px;line-height:1.5}</style></head>` +
    `<body><div class="card">${body}</div>` +
    `<script>setTimeout(()=>{try{window.close()}catch(e){}},2500)</script></body></html>`
  );
}

/**
 * Fire-and-forget hook: kick MCP into reconnecting (or disconnecting) for a
 * given provider id. No-ops for non-MCP-backed providers. Errors are logged,
 * not thrown — credential CRUD shouldn't block on subprocess lifecycle.
 */
function syncMcpForProvider(providerId: string): void {
  mcpService.syncFromProvider(providerId).catch((err: unknown) => {
    const message = getErrorMessage(err);
    logger.warn(`[providers] mcp sync failed for ${providerId}: ${message}`);
  });
}

/**
 * Fire-and-forget hook: run a model-discovery pass for a provider and persist
 * the results into the `models` catalog. Without this, a credential created
 * over the API (which never visits the UI model picker) leaves every model
 * uncataloged, so context budgets fall back to the 8192-token default. Best
 * effort — a discovery failure must never fail credential creation.
 */
function syncModelCatalogForProvider(providerId: string): void {
  persistDiscoveredModels(providerId)
    .then((summary) => {
      const note = summary.warning ? ` (warning: ${summary.warning})` : '';
      logger.info(
        `[providers] model catalog sync for ${providerId}: ${summary.imported} imported, ` +
          `${summary.backfilled} backfilled of ${summary.discovered} discovered${note}`
      );
    })
    .catch((err: unknown) => {
      logger.warn(
        `[providers] model catalog sync failed for ${providerId}: ${getErrorMessage(err)}`
      );
    });
}

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const providers = await providerService.list();
    sendOk(res, providers);
  })
);

// The model an agent with no model of its own adopts on its first run, so the
// Get started pane can offer it first. Registered before `/:id`.
router.get(
  '/default-model',
  asyncHandler(async (_req, res) => {
    sendOk(res, await suggestConnectedModel());
  })
);

router.get(
  '/credentials',
  asyncHandler(async (_req, res) => {
    const credentials = await providerCredentialService.listSafe();
    sendOk(res, credentials);
  })
);

// GET /api/providers/credentials/:id/export — return copyable credential payload
router.get(
  '/credentials/:id/export',
  asyncHandler(async (req, res) => {
    const credential = await providerCredentialService.exportById(req.params.id);
    if (!credential) {
      throw new AppError(
        `Credential '${req.params.id}' not found`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    sendOk(res, credential);
  })
);

router.post(
  '/credentials',
  asyncHandler(async (req, res) => {
    const body = await parseProviderCredentialInput(req.body);

    const credential = await providerCredentialService.save({
      providerId: body.providerId,
      authTypeId: body.authTypeId,
      authType: body.authType,
      label: body.label,
      secret: body.secret,
      metadata: body.metadata,
    });

    // A new credential has not been tested, even if the draft was tested earlier.
    credential.verificationStatus = 'untested';

    // For integrations, hand off to MCP — spawns the server if the integration
    // is enabled and the token is present. For LLM providers, kick a catalog
    // sync instead so the new credential's models land with real context
    // windows before an agent ever runs against them.
    const providerRow = await Providers.findById(body.providerId);
    if (providerRow?.type === 'integration') {
      syncMcpForProvider(body.providerId);
    } else {
      syncModelCatalogForProvider(body.providerId);
    }

    sendCreated(res, credential);
  })
);

// POST /api/providers/credentials/import-cli — one-click import of local CLI
// auth for supported providers. Reads the Codex CLI's ~/.codex/auth.json or
// the Claude Code CLI's macOS keychain entry (both read-only), validates the
// credential format, then persists without a live authentication test
// (refresh tokens are peeled into the encrypted bundle by the service layer).
router.post(
  '/credentials/import-cli',
  asyncHandler(async (req, res) => {
    const body = req.body as { providerId?: string };
    const providerId = body.providerId;

    let secret: string;
    let authTypeId: string;
    let label: string;
    let metadata: Record<string, unknown> | undefined;

    if (providerId === 'codex') {
      const cli = await readCodexCliAuth();
      if (!cli) {
        throw new AppError(
          'No Codex CLI login found — run `codex login` first (~/.codex/auth.json).',
          ErrorCode.NOT_FOUND,
          HTTP_STATUS.NOT_FOUND
        );
      }
      if (!cli.accessToken || !cli.accountId) {
        throw new AppError(
          'Codex CLI auth file is missing access_token or account_id — re-run `codex login`.',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      secret = cli.accessToken;
      authTypeId = 'codex:codex-subscription';
      label = 'Codex CLI (imported)';
      metadata = { refresh_token: cli.refreshToken, account_id: cli.accountId };
    } else if (providerId === 'anthropic') {
      // Claude Code keeps its own keychain entry current; mirror it in place
      // (one row, never a duplicate) and leave it untested like the Codex path.
      const synced = await syncClaudeCodeCredential({ verify: false });
      syncModelCatalogForProvider(providerId);
      sendCreated(res, synced.credential);
      return;
    } else {
      throw new AppError(
        "providerId must be 'codex' or 'anthropic'",
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    await parseProviderCredentialInput({
      providerId,
      authTypeId,
      authType: 'oauth',
      secret,
      metadata,
    });

    // Upsert: replace an existing credential for the same auth type instead of
    // stacking duplicate imports.
    const existing = (await providerCredentialService.listSafe()).find(
      (c) => c.providerId === providerId && c.authTypeId === authTypeId
    );
    const credential = existing
      ? await providerCredentialService.edit(existing.id, { label, secret, metadata })
      : await providerCredentialService.save({
          providerId,
          authTypeId,
          authType: 'oauth',
          label,
          secret,
          metadata,
        });
    if (!credential) {
      throw new AppError(
        'Failed to persist imported credential',
        ErrorCode.INTERNAL_ERROR,
        HTTP_STATUS.INTERNAL_SERVER_ERROR
      );
    }

    await UserProviderCredentials.updateVerificationStatus(credential.id, 'untested');
    credential.verificationStatus = 'untested';

    // Codex/Anthropic are LLM providers — same catalog sync as the manual
    // credential path, for the same reason (fire-and-forget, best-effort).
    syncModelCatalogForProvider(providerId);

    sendCreated(res, credential);
  })
);

// Claude Code sign-in. The session is registered before any keychain or
// network work, so duplicate clicks join it and Cancel always has an id. It
// connects without a browser when the keychain login verifies; otherwise it
// runs `claude auth login` and the desktop polls until it settles.
router.post(
  '/anthropic/claude-code/login',
  asyncHandler(async (_req, res) => {
    const session = claudeCodeLoginService.start();
    res.status(202);
    sendOk(res, session);
  })
);

router.get(
  '/anthropic/claude-code/login/:sessionId',
  asyncHandler(async (req, res) => {
    const session = claudeCodeLoginService.status(req.params.sessionId);
    if (!session) {
      throw new AppError('Sign-in session not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    if (session.state === 'connected') syncModelCatalogForProvider('anthropic');
    sendOk(res, session);
  })
);

router.delete(
  '/anthropic/claude-code/login/:sessionId',
  asyncHandler(async (req, res) => {
    const session = claudeCodeLoginService.cancel(req.params.sessionId);
    if (!session) {
      throw new AppError('Sign-in session not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, session);
  })
);

// Pins on the deleted credential (provider primary, agents, thread model
// overrides, summary-model overrides) move to the provider's primary or best
// remaining credential in the same transaction, or are cleared when none is
// left. The response says what moved so the UI can tell the user.
router.delete(
  '/credentials/:id',
  asyncHandler(async (req, res) => {
    const result = await deleteCredentialRepointingPins(req.params.id);
    if (!result) {
      throw new AppError(
        `Credential '${req.params.id}' not found`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    syncMcpForProvider(result.deleted.providerId);
    sendOk(res, {
      deleted: result.deleted,
      repointed: result.repointed,
      message: describePinChanges(result.repointed) || null,
    });
  })
);

// PATCH /api/providers/credentials/:id — update label and/or secret
router.patch(
  '/credentials/:id',
  asyncHandler(async (req, res) => {
    const body = req.body as {
      label?: string;
      secret?: string;
      metadata?: Record<string, unknown>;
    };
    const updated = await providerCredentialService.edit(req.params.id, body);
    if (!updated) {
      throw new AppError(
        `Credential '${req.params.id}' not found`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    // Secret may have changed — reconnect the MCP server so the new token
    // takes effect. No-op for LLM providers.
    if (body.secret !== undefined) syncMcpForProvider(updated.providerId);
    sendOk(res, updated);
  })
);

// POST /api/providers/credentials/:id/test — retest a saved credential
router.post(
  '/credentials/:id/test',
  asyncHandler(async (req, res) => {
    const credential = await providerCredentialService.getFullCredentialById(req.params.id);
    if (!credential) {
      throw new AppError(
        `Credential '${req.params.id}' not found`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    const secret = credential.encryptedSecret; // already decrypted by getFullCredentialById
    const result = await providerChatService.verify(credential.providerId, secret, {
      authType: credential.authType,
      metadata: (credential.metadataJson ?? {}) as Record<string, unknown>,
      credentialId: credential.id,
    });

    // Persist the verification result
    await UserProviderCredentials.updateVerificationStatus(
      req.params.id,
      result.valid ? 'ok' : 'fail'
    );
    // A key that works refreshes its provider's catalog, so limits the
    // provider reports replace stored ones and new models appear.
    const providerRow = await Providers.findById(credential.providerId);
    if (result.valid && providerRow?.type !== 'integration') {
      syncModelCatalogForProvider(credential.providerId);
    }

    sendOk(res, result);
  })
);

router.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const { providerId, secret, authType, metadata } = req.body as {
      providerId?: string;
      secret?: string;
      authType?: string;
      metadata?: Record<string, unknown>;
    };
    const credentialless = providerId === 'ollama' || providerId === 'lm-studio';
    if (
      typeof providerId !== 'string' ||
      !providerId.trim() ||
      (secret !== undefined && typeof secret !== 'string') ||
      (!credentialless && !secret) ||
      (authType !== undefined && typeof authType !== 'string')
    ) {
      throw new AppError(
        'providerId and secret are required (local Ollama and LM Studio do not need a secret)',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const result = await providerChatService.verify(providerId, secret ?? '', {
      authType,
      metadata,
    });
    sendOk(res, result);
  })
);

// PATCH /api/providers/:id/credential — set or clear primary credential
router.patch(
  '/:id/credential',
  asyncHandler(async (req, res) => {
    const { credentialId } = req.body as { credentialId?: string | null };
    const updated = await providerService.setPrimaryCredential(req.params.id, credentialId ?? null);
    if (!updated) {
      throw new AppError(
        `Provider '${req.params.id}' not found`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    sendOk(res, updated);
  })
);

// PATCH /api/providers/:id/enabled — integration connection policy.
router.patch(
  '/:id/enabled',
  asyncHandler(async (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      throw new AppError(
        'enabled (boolean) is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const existing = await Providers.findById(req.params.id);
    if (!existing) {
      throw new AppError(
        `Provider '${req.params.id}' not found`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    if (existing.type !== 'integration') {
      throw new AppError(
        'Only integration providers can be enabled or disabled',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const updated = await providerService.setEnabled(req.params.id, enabled);
    syncMcpForProvider(req.params.id);
    sendOk(res, updated);
  })
);

// PATCH /api/providers/:id — update editable fields (currently base_url only).
// The canonical `openai` provider rejects base_url changes (its URL is
// hard-pinned in code). Pass `baseUrl: null` to clear the value and let the
// provider fall back to its file-level default.
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { baseUrl } = req.body as { baseUrl?: string | null };
    if (baseUrl === undefined) {
      throw new AppError(
        'baseUrl is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    try {
      const trimmed = typeof baseUrl === 'string' ? baseUrl.trim() : null;
      const value = trimmed && trimmed.length > 0 ? trimmed : null;
      const updated = await providerService.updateBaseUrl(req.params.id, value);
      if (!updated) {
        throw new AppError(
          `Provider '${req.params.id}' not found`,
          ErrorCode.NOT_FOUND,
          HTTP_STATUS.NOT_FOUND
        );
      }
      sendOk(res, updated);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(getErrorMessage(err), ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
  })
);

router.get(
  '/:id/fallback-credentials',
  asyncHandler(async (req, res) => {
    const rows = await ProviderFallbackCredentials.listByProviderId(req.params.id);
    sendOk(res, rows);
  })
);

router.post(
  '/:id/fallback-credentials',
  asyncHandler(async (req, res) => {
    const { credentialId, fallbackIndex } = req.body as {
      credentialId?: string;
      fallbackIndex?: number;
    };
    if (!credentialId) {
      throw new AppError(
        'credentialId is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const row = await ProviderFallbackCredentials.addFallback(
      req.params.id,
      credentialId,
      fallbackIndex
    );
    sendCreated(res, row);
  })
);

router.delete(
  '/:id/fallback-credentials/:credentialId',
  asyncHandler(async (req, res) => {
    const removed = await ProviderFallbackCredentials.removeFallback(
      req.params.id,
      req.params.credentialId
    );
    if (!removed) {
      throw new AppError(
        'Fallback credential not found',
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    sendOk(res, null);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const provider = await providerService.get(req.params.id);
    if (!provider) {
      throw new AppError(
        `Provider '${req.params.id}' not found`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
    sendOk(res, provider);
  })
);

export default router;

// Google Workspace OAuth
//
// Provider key `google-workspace` (not `google` — Gemini owns that). Snaglet uses
// a single workspace-owned connection: the callback replaces any existing
// google-workspace credential so there is always exactly one.

// Returns the configured-state of the OAuth client credentials. Never returns
// the secret — the UI only needs to know whether the desktop client is set.
router.get(
  '/google-workspace/client-config',
  asyncHandler(async (_req, res) => {
    const creds = await getStoredClientCreds();
    if (!creds) {
      sendOk(res, { configured: false });
      return;
    }
    sendOk(res, {
      configured: true,
      clientId: creds.clientId,
      source: creds.source,
    });
  })
);

// Upsert the Google Desktop app OAuth client credentials (encrypted in DB).
router.put(
  '/google-workspace/client-config',
  asyncHandler(async (req, res) => {
    const { clientId, clientSecret } = req.body as {
      clientId?: string;
      clientSecret?: string;
    };
    if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
      throw new AppError(
        'clientId and clientSecret are required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    if (!clientId.trim() || !clientSecret.trim()) {
      throw new AppError(
        'clientId and clientSecret cannot be empty',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    await setStoredClientCreds({ clientId, clientSecret });
    sendOk(res, { configured: true, clientId: clientId.trim(), source: 'db' });
  })
);

// Clear stored OAuth client creds (forces re-entry).
router.delete(
  '/google-workspace/client-config',
  asyncHandler(async (_req, res) => {
    await clearStoredClientCreds();
    sendOk(res, null);
  })
);

// Returns the Google consent-screen URL for the Providers-page Connect button.
// `startGoogleOAuth` resolves the redirect URI, records the single-use state,
// and pins the two together — the callback below will not accept a state it
// did not issue here.
router.get(
  '/google-workspace/oauth/start',
  asyncHandler(async (_req, res) => {
    // Checked here so a missing/undecryptable client is a 400 the UI can show
    // verbatim, not a 500 "An unexpected error occurred" that tells the user
    // nothing about which of the two things to fix.
    const creds = await getStoredClientCreds();
    if (!creds) {
      throw new AppError(
        'Google OAuth client is not usable: no Client ID/Secret is stored, or the stored ' +
          "secret could not be decrypted with this server's CREDENTIAL_ENCRYPTION_KEY. " +
          'Enter the Desktop-app Client ID and Secret under Providers → Google, then Connect.',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const { url, state } = await startGoogleOAuth();
    sendOk(res, { url, state });
  })
);

// Google redirects here with ?code=. Exchange it, persist the single workspace
// credential, and render a self-closing success page (Tauri opens the system
// browser, so we land the user on a "you can close this tab" page and let the
// app re-poll credential status).
router.get(
  '/google-workspace/oauth/callback',
  asyncHandler(async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const oauthError = typeof req.query.error === 'string' ? req.query.error : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';

    const fail = (status: number, detail: string) => {
      res
        .status(status)
        .type('html')
        .send(
          oauthResultPage(
            'Google connection failed',
            `<h1>Could not connect Google</h1><p>${escapeHtml(detail)} You can close this tab and try again.</p>`
          )
        );
    };

    // CSRF gate first. Redeeming the state is what proves this callback
    // belongs to a Connect click that happened in this app: without it, any
    // page that can make the browser load this URL can plant an authorization
    // code for an account the user never chose. Single-use, so a replayed
    // callback lands here too. Every rejection reason gets the same copy —
    // the distinctions are only useful to someone probing.
    const pending = consumeGoogleOAuthState(state);
    if (!pending) {
      fail(
        400,
        'This sign-in link has expired or was not started from Snaglet. Open Providers → Google and click Connect again.'
      );
      return;
    }

    if (oauthError || !code) {
      fail(400, oauthError || 'No authorization code returned.');
      return;
    }

    // Exchange against the redirect URI pinned to the state, not a freshly
    // resolved one — Google compares it to the authorization request and
    // answers `redirect_uri_mismatch` if the two ever drift.
    let tokens: Awaited<ReturnType<typeof exchangeGoogleCode>>;
    try {
      tokens = await exchangeGoogleCode(code, pending.redirectUri);
    } catch (err) {
      // Render the friendly page rather than letting the error middleware
      // return JSON to a browser tab the user is staring at.
      const message = getErrorMessage(err);
      logger.warn(`[google-workspace] oauth token exchange failed: ${message}`);
      fail(502, `Google rejected the token exchange: ${message}`);
      return;
    }

    // Single workspace connection: drop any existing google-workspace credential.
    const existing = await UserProviderCredentials.findByProviderId('google-workspace');
    if (existing) {
      await providerCredentialService.remove(existing.id);
    }

    await providerCredentialService.save({
      providerId: 'google-workspace',
      authTypeId: 'google-workspace:oauth',
      authType: 'oauth',
      label: tokens.accountEmail ? `Google (${tokens.accountEmail})` : 'Google Workspace',
      secret: tokens.accessToken,
      metadata: {
        refresh_token: tokens.refreshToken ?? '',
        expires: tokens.expires,
        account_email: tokens.accountEmail ?? '',
      },
    });

    res
      .type('html')
      .send(
        oauthResultPage(
          'Google connected',
          `<h1>Google connected</h1><p>${
            tokens.accountEmail ? `Connected as ${escapeHtml(tokens.accountEmail)}. ` : ''
          }You can close this tab and return to Snaglet.</p>`
        )
      );
  })
);
