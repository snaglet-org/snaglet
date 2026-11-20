/**
 * mcpAuth — API-key authentication for the external MCP surface (/mcp).
 *
 * Identity model: each key is minted
 * in Settings and maps to ONE members row (kind='external'). The plaintext
 * token is shown once at mint time; the server stores only its SHA-256 hex
 * hash. Bearer validation on every request: no key, no access — there is no
 * anonymous tier. Revocation deletes the key row, so a revoked key simply has
 * no row to match and is refused.
 *
 * last_used_at is stamped at most once per key per LAST_USED_THROTTLE_MS so
 * a chatty MCP client doesn't turn every call into an UPDATE.
 *
 * Key format: `snaglet_mcp_<home tag>_<48 hex>`. The tag is 8 random hex
 * made once per Snaglet home and kept in `<SNAGLET_HOME>/runtime/mcp-key-tag` (like
 * the hook CLI token next to it), so it says nothing about the home's path:
 * a caller cannot confirm a guessed SNAGLET_HOME from the 401 wording. A
 * token without the tag shape is refused before any lookup; a well-formed one
 * is looked up by the hash of the whole token. The tag never accepts or refuses
 * a well-formed key; it only words the 401 when the lookup fails, so a key sent
 * to another Snaglet (a production key to the dev server) says so. No message
 * names a home path or a tag.
 */

import { createHash, randomBytes } from 'crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import type { NextFunction, Request, Response } from 'express';
import { McpApiKeys, Members } from '@snaglet/db';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { SNAGLET_RUNTIME_DIR } from '@server/services/snagletHome';
import type { ExternalCaller } from './McpGatewayService';

/** Prefix makes leaked tokens greppable/identifiable (like ghp_, sk-...). */
const KEY_PREFIX = 'snaglet_mcp_';
/** A key minted with a home tag: `snaglet_mcp_<8 hex>_<48 hex>`. */
const TAGGED_KEY = /^snaglet_mcp_([0-9a-f]{8})_[0-9a-f]{48}$/;

const WRONG_HOME_MESSAGE =
  "This key isn't valid for this Snaglet: it was made by a different Snaglet home. Check SNAGLET_HOME / which Snaglet app is running.";
const INVALID_KEY_MESSAGE =
  'Invalid or revoked API key. If you run more than one Snaglet (an installed app and a dev server), check SNAGLET_HOME / which Snaglet app is running.';

const HOME_TAG_FILE = path.join(SNAGLET_RUNTIME_DIR, 'mcp-key-tag');
const HOME_TAG = /^[0-9a-f]{8}$/;

let homeTag: string | null = null;

/**
 * This Snaglet home's key tag (see the header): read from its file, else made
 * and saved there (owner-only, written whole through a temp file). If it
 * cannot be saved this process still uses one tag throughout; a later start
 * makes another, which only rewords the 401 for keys minted meanwhile.
 */
function homeKeyTag(): string {
  if (homeTag !== null) return homeTag;
  try {
    const saved = readFileSync(HOME_TAG_FILE, 'utf8').trim();
    if (HOME_TAG.test(saved)) return (homeTag = saved);
  } catch {
    /* none yet: make one below */
  }
  homeTag = randomBytes(4).toString('hex');
  try {
    mkdirSync(path.dirname(HOME_TAG_FILE), { recursive: true });
    const temporary = `${HOME_TAG_FILE}.${process.pid}.tmp`;
    writeFileSync(temporary, `${homeTag}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, HOME_TAG_FILE);
  } catch (err) {
    logger.warn(`[mcp-auth] could not save the key tag: ${getErrorMessage(err)}`);
  }
  return homeTag;
}

/** Why a token found no key: another home's tag, or simply invalid or revoked. */
function rejectedKeyMessage(token: string): string {
  const tag = TAGGED_KEY.exec(token.trim())?.[1];
  return tag !== undefined && tag !== homeKeyTag() ? WRONG_HOME_MESSAGE : INVALID_KEY_MESSAGE;
}

const LAST_USED_THROTTLE_MS = 60_000;
const lastTouched = new Map<string, number>();

export async function authenticateMcpKey(token: string): Promise<ExternalCaller | null> {
  const trimmed = token.trim();
  if (!TAGGED_KEY.test(trimmed)) return null;
  const key = await McpApiKeys.findActiveByHash(hashMcpKeyToken(trimmed));
  if (!key) return null;
  const member = await Members.findById(key.memberId);
  if (!member) return null;

  const now = Date.now();
  const last = lastTouched.get(key.id) ?? 0;
  if (now - last >= LAST_USED_THROTTLE_MS) {
    lastTouched.set(key.id, now);
    void McpApiKeys.touchLastUsed(key.id).catch((err) =>
      logger.warn(`[mcp-auth] last_used_at stamp failed: ${getErrorMessage(err)}`)
    );
  }
  return { memberId: member.id, name: key.name };
}

/** Mint a new plaintext token, tagged with this home. Shown once; only its hash is stored. */
export function generateMcpKeyToken(): string {
  return `${KEY_PREFIX}${homeKeyTag()}_${randomBytes(24).toString('hex')}`;
}

/** SHA-256 hex of a plaintext token — the stored/looked-up form. */
export function hashMcpKeyToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by mcpAuthMiddleware: the authenticated external caller. */
    mcpCaller?: ExternalCaller;
  }
}

function unauthorized(res: Response, message: string): void {
  // JSON-RPC-shaped error body so MCP clients surface a readable reason.
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message },
    id: null,
  });
}

/**
 * Express middleware guarding /mcp: `Authorization: Bearer <token>` ->
 * hash lookup -> active key -> member. Attaches req.mcpCaller on success.
 */
export function mcpAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) {
      unauthorized(
        res,
        'Missing API key. Send `Authorization: Bearer <key>` — create one in Snaglet MCP → Client connections.'
      );
      return;
    }

    const caller = await authenticateMcpKey(match[1]!);
    if (!caller) {
      unauthorized(res, rejectedKeyMessage(match[1]!));
      return;
    }
    req.mcpCaller = caller;
    next();
  })().catch((err) => {
    logger.error(`[mcp-auth] auth check failed: ${getErrorMessage(err)}`);
    unauthorized(res, 'Authentication failed.');
  });
}
