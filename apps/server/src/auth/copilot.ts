/**
 * GitHub Copilot OAuth — device code flow.
 *
 * Uses the VS Code Copilot extension's client ID (Iv1.b507a08c87ecfe98)
 * which implicitly grants Copilot API access via the device code flow.
 *
 * Endpoints:
 *   POST /auth/copilot/device-code  — request a device code from GitHub
 *   POST /auth/copilot/poll         — poll until user authorizes, returns ghu_* token
 */

import { Router } from 'express';
import { asyncHandler, oauthRateLimiter } from '@server/middleware';

const router = Router();

const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

// Kicks off the GitHub device code flow. Returns a user_code and
// verification_uri for the user to visit github.com/login/device.
router.post(
  '/device-code',
  oauthRateLimiter,
  asyncHandler(async (_req, res) => {
    const body = new URLSearchParams({
      client_id: COPILOT_CLIENT_ID,
      scope: 'read:user',
    });

    const ghRes = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!ghRes.ok) {
      const text = await ghRes.text().catch(() => '');
      res.status(502).json({ error: `GitHub device code failed (${ghRes.status})`, detail: text });
      return;
    }

    const data = (await ghRes.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

    res.json({
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval,
    });
  })
);

// Poll GitHub for the access token. The client calls this repeatedly
// until the user authorizes (or the code expires).
router.post(
  '/poll',
  oauthRateLimiter,
  asyncHandler(async (req, res) => {
    const { deviceCode } = req.body as { deviceCode?: string };
    if (!deviceCode) {
      res.status(400).json({ error: 'Missing deviceCode' });
      return;
    }

    const body = new URLSearchParams({
      client_id: COPILOT_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });

    const ghRes = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!ghRes.ok) {
      const text = await ghRes.text().catch(() => '');
      res.status(502).json({ error: `GitHub token poll failed (${ghRes.status})`, detail: text });
      return;
    }

    const data = (await ghRes.json()) as Record<string, unknown>;

    if ('access_token' in data && typeof data.access_token === 'string') {
      res.json({ status: 'complete', accessToken: data.access_token });
      return;
    }

    const error = String(data.error ?? 'unknown');
    if (error === 'authorization_pending') {
      res.json({ status: 'pending' });
      return;
    }
    if (error === 'slow_down') {
      res.json({ status: 'slow_down' });
      return;
    }
    if (error === 'expired_token') {
      res.json({ status: 'expired', error: 'Device code expired. Please start over.' });
      return;
    }
    if (error === 'access_denied') {
      res.json({ status: 'denied', error: 'Authorization was denied.' });
      return;
    }

    res.json({ status: 'error', error: `GitHub device flow error: ${error}` });
  })
);

export default router;
