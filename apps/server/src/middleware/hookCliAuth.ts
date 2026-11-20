import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { SNAGLET_RUNTIME_DIR } from '@server/services/snagletHome';
import { toolDispatchAuthMiddleware } from './panelAuth';

const HOOK_CLI_TOKEN_PATH = path.join(SNAGLET_RUNTIME_DIR, 'hook-cli-token');

function loadOrCreateToken(): string {
  try {
    const existing = readFileSync(HOOK_CLI_TOKEN_PATH, 'utf-8').trim();
    if (existing) return existing;
  } catch {
    // Create below.
  }
  mkdirSync(path.dirname(HOOK_CLI_TOKEN_PATH), { recursive: true });
  const token = randomBytes(32).toString('base64url');
  writeFileSync(HOOK_CLI_TOKEN_PATH, `${token}\n`, { encoding: 'utf-8', mode: 0o600 });
  return token;
}

const HOOK_CLI_TOKEN = loadOrCreateToken();

function matches(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Accept the local hook CLI token, otherwise retain normal panel/child auth. */
export function hookCommandAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const presented = req.get('x-snaglet-hook-cli-token');
  if (presented && matches(presented, HOOK_CLI_TOKEN)) {
    req.toolExecuteAuthScope = 'panel';
    next();
    return;
  }
  toolDispatchAuthMiddleware(req, res, next);
}
