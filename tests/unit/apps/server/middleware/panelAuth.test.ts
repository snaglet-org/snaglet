/**
 * Panel execution auth — the token gate on POST /api/tools/execute and
 * /execute/test (trust boundary documented in middleware/panelAuth.ts).
 * Missing/invalid X-Snaglet-Panel-Token → 403, never 404 (ToolView reads 404 as
 * "execution disabled in this build"); the correct panel token or the
 * `snaglet run` CLI's X-Snaglet-Sidecar-Token → allowed; constant-time comparison never
 * throws on a length mismatch; child-dispatch tokens are bound to one agent,
 * which blocks cross-agent impersonation.
 */

import type { Request, Response } from 'express';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';
import {
  getPanelToken,
  mintChildDispatchToken,
  verifyChildDispatchToken,
  panelAuthMiddleware,
  toolDispatchAuthMiddleware,
} from '@server/middleware/panelAuth';

const makeReq = (headers: Record<string, string | undefined> = {}): Request =>
  ({
    get: (name: string) => headers[name.toLowerCase()],
  }) as unknown as Request;

const makeRes = () => ({}) as Response;

const savedSidecarToken = process.env.SNAGLET_AUTH_TOKEN;

afterEach(() => {
  if (savedSidecarToken === undefined) delete process.env.SNAGLET_AUTH_TOKEN;
  else process.env.SNAGLET_AUTH_TOKEN = savedSidecarToken;
});

describe('getPanelToken', () => {
  test('returns a non-empty, stable value for the process lifetime', () => {
    const a = getPanelToken();
    const b = getPanelToken();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).toBe(b);
  });
});

describe('panelAuthMiddleware', () => {
  test('rejects a request with no panel-token header at all — 403, not 404', () => {
    const next = jest.fn();
    panelAuthMiddleware(makeReq(), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe(ErrorCode.FORBIDDEN);
  });

  test('rejects the wrong X-Snaglet-Panel-Token', () => {
    const next = jest.fn();
    panelAuthMiddleware(makeReq({ 'x-snaglet-panel-token': 'not-the-token' }), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(403);
  });

  test('rejects a token of the same length but different bytes (exercises the byte comparison, not just the length guard)', () => {
    const real = getPanelToken();
    const sameLengthWrong = real.slice(0, -1) + (real.at(-1) === 'a' ? 'b' : 'a');
    const next = jest.fn();
    panelAuthMiddleware(makeReq({ 'x-snaglet-panel-token': sameLengthWrong }), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(AppError);
  });

  test('rejects a token that is a strict prefix of the real one (length mismatch) without throwing', () => {
    const real = getPanelToken();
    const next = jest.fn();
    expect(() =>
      panelAuthMiddleware(makeReq({ 'x-snaglet-panel-token': real.slice(0, 4) }), makeRes(), next)
    ).not.toThrow();
    expect(next.mock.calls[0][0]).toBeInstanceOf(AppError);
  });

  test('allows the correct X-Snaglet-Panel-Token — next() called with no error', () => {
    const next = jest.fn();
    panelAuthMiddleware(makeReq({ 'x-snaglet-panel-token': getPanelToken() }), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  test('allows the snaglet-run CLI path: X-Snaglet-Sidecar-Token matching SNAGLET_AUTH_TOKEN', () => {
    process.env.SNAGLET_AUTH_TOKEN = 'sidecar-secret';
    const next = jest.fn();
    panelAuthMiddleware(makeReq({ 'x-snaglet-sidecar-token': 'sidecar-secret' }), makeRes(), next);

    expect(next).toHaveBeenCalledWith();
  });

  test('rejects a wrong X-Snaglet-Sidecar-Token', () => {
    process.env.SNAGLET_AUTH_TOKEN = 'sidecar-secret';
    const next = jest.fn();
    panelAuthMiddleware(makeReq({ 'x-snaglet-sidecar-token': 'wrong' }), makeRes(), next);

    expect(next.mock.calls[0][0]).toBeInstanceOf(AppError);
  });

  test('X-Snaglet-Sidecar-Token is not accepted when SNAGLET_AUTH_TOKEN is unset', () => {
    delete process.env.SNAGLET_AUTH_TOKEN;
    const next = jest.fn();
    panelAuthMiddleware(makeReq({ 'x-snaglet-sidecar-token': 'anything' }), makeRes(), next);

    expect(next.mock.calls[0][0]).toBeInstanceOf(AppError);
  });

  test('marks req.toolExecuteAuthScope = "panel" on success via the panel token', () => {
    const req = makeReq({ 'x-snaglet-panel-token': getPanelToken() });
    const next = jest.fn();
    panelAuthMiddleware(req, makeRes(), next);

    expect(req.toolExecuteAuthScope).toBe('panel');
  });

  test('marks req.toolExecuteAuthScope = "panel" on success via the sidecar token', () => {
    process.env.SNAGLET_AUTH_TOKEN = 'sidecar-secret';
    const req = makeReq({ 'x-snaglet-sidecar-token': 'sidecar-secret' });
    const next = jest.fn();
    panelAuthMiddleware(req, makeRes(), next);

    expect(req.toolExecuteAuthScope).toBe('panel');
  });
});

describe('mintChildDispatchToken / verifyChildDispatchToken (per-agent binding)', () => {
  test('a token minted for agent A verifies back to agent A', () => {
    const token = mintChildDispatchToken('agent-a');
    expect(verifyChildDispatchToken(token)).toEqual({ agentId: 'agent-a' });
  });

  test('tokens minted for different agents are distinct values', () => {
    const a = mintChildDispatchToken('agent-a');
    const b = mintChildDispatchToken('agent-b');
    expect(a).not.toBe(b);
  });

  test('minting twice for the same agent is deterministic (same secret, same payload)', () => {
    const a = mintChildDispatchToken('agent-a');
    const b = mintChildDispatchToken('agent-a');
    expect(a).toBe(b);
  });

  test('an unbound token (no agentId; /execute rejects it, so every spawn site binds one) verifies to an empty agentId', () => {
    const token = mintChildDispatchToken();
    expect(verifyChildDispatchToken(token)).toEqual({ agentId: '' });
  });

  test('is distinct from the panel token', () => {
    expect(mintChildDispatchToken('agent-a')).not.toBe(getPanelToken());
  });

  test('cannot forge a binding by editing the payload without the matching signature', () => {
    // Simulates an attacker who has a valid token for agent A and tries to
    // relabel it as agent B by hand-editing the base64url payload segment,
    // without knowing CHILD_DISPATCH_SECRET (in-memory, per-boot) needed to
    // produce a matching HMAC.
    const tokenForA = mintChildDispatchToken('agent-a');
    const [, mac] = tokenForA.split('.');
    const forgedPayload = Buffer.from('agent-b', 'utf8').toString('base64url');
    const forged = `${forgedPayload}.${mac}`;

    expect(verifyChildDispatchToken(forged)).toBeNull();
  });

  test('rejects a malformed token (no "." separator) without throwing', () => {
    expect(() => verifyChildDispatchToken('not-a-valid-token')).not.toThrow();
    expect(verifyChildDispatchToken('not-a-valid-token')).toBeNull();
  });

  test('rejects a completely forged token (random bytes, right shape, wrong signature)', () => {
    expect(verifyChildDispatchToken('YWdlbnQtYQ.deadbeefdeadbeefdeadbeefdeadbeef')).toBeNull();
  });
});

describe('child-dispatch token carries a signed hook chain', () => {
  test('the chain round-trips in order, with the hook name and depth', () => {
    const token = mintChildDispatchToken('agent-a', 'test-hook-b', 2, [
      'test-hook-a',
      'test-hook-b',
    ]);
    expect(verifyChildDispatchToken(token)).toEqual({
      agentId: 'agent-a',
      hookName: 'test-hook-b',
      chainDepth: 2,
      hookChain: ['test-hook-a', 'test-hook-b'],
    });
    // A tool child spawned by a hook's tool call: depth and chain, no hook name.
    expect(
      verifyChildDispatchToken(mintChildDispatchToken('agent-a', undefined, 1, ['test-hook-a']))
    ).toEqual({ agentId: 'agent-a', chainDepth: 1, hookChain: ['test-hook-a'] });
  });

  test('a depth-0 token with no chain stays byte-identical', () => {
    expect(mintChildDispatchToken('agent-a', undefined, 0, [])).toBe(
      mintChildDispatchToken('agent-a')
    );
    expect(mintChildDispatchToken()).toBe(mintChildDispatchToken(undefined, undefined, 0, []));
  });

  test('a child cannot shorten or clear its chain: an edited payload fails the signature', () => {
    const token = mintChildDispatchToken('agent-a', 'test-hook-b', 2, [
      'test-hook-a',
      'test-hook-b',
    ]);
    const [payload, mac] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    for (const edited of [
      { ...decoded, hookChain: ['test-hook-b'] },
      { ...decoded, hookChain: [] },
      { agentId: decoded.agentId, hookName: decoded.hookName, chainDepth: decoded.chainDepth },
    ]) {
      const forged = Buffer.from(JSON.stringify(edited), 'utf8').toString('base64url');
      expect(verifyChildDispatchToken(`${forged}.${mac}`)).toBeNull();
    }
  });

  test('a signed but malformed chain is rejected: over 32 names, a name over 128 characters, an empty name or a non-string', () => {
    const tooLong = Array.from({ length: 33 }, (_, i) => `hook-${i}`);
    expect(verifyChildDispatchToken(mintChildDispatchToken('agent-a', 'h', 1, tooLong))).toBeNull();
    expect(
      verifyChildDispatchToken(mintChildDispatchToken('agent-a', 'h', 1, ['x'.repeat(129)]))
    ).toBeNull();
    expect(verifyChildDispatchToken(mintChildDispatchToken('agent-a', 'h', 1, ['']))).toBeNull();
    expect(
      verifyChildDispatchToken(mintChildDispatchToken('agent-a', 'h', 1, [7 as unknown as string]))
    ).toBeNull();
    // The limits themselves are fine.
    const full = Array.from({ length: 32 }, (_, i) => `hook-${i}`);
    expect(
      verifyChildDispatchToken(mintChildDispatchToken('agent-a', 'h', 1, full))?.hookChain
    ).toEqual(full);
  });

  test('toolDispatchAuthMiddleware exposes the signed chain (empty when the token has none)', () => {
    const withChain = makeReq({
      'x-snaglet-child-dispatch-token': mintChildDispatchToken('agent-a', 'test-hook-a', 1, [
        'test-hook-a',
      ]),
    });
    toolDispatchAuthMiddleware(withChain, makeRes(), jest.fn());
    expect(withChain.childDispatchChain).toEqual(['test-hook-a']);

    const without = makeReq({
      'x-snaglet-child-dispatch-token': mintChildDispatchToken('agent-a'),
    });
    toolDispatchAuthMiddleware(without, makeRes(), jest.fn());
    expect(without.childDispatchChain).toEqual([]);
  });
});

describe('child-dispatch token carries a signed unattended cap', () => {
  test('the cap round-trips, is exposed on the request, and an uncapped token is unchanged', () => {
    const capped = mintChildDispatchToken('agent-a', 'test-hook-a', 1, ['test-hook-a'], true);
    expect(verifyChildDispatchToken(capped)).toEqual({
      agentId: 'agent-a',
      hookName: 'test-hook-a',
      chainDepth: 1,
      hookChain: ['test-hook-a'],
      unattendedCap: true,
    });
    expect(mintChildDispatchToken('agent-a', 'test-hook-a', 1, ['test-hook-a'], false)).toBe(
      mintChildDispatchToken('agent-a', 'test-hook-a', 1, ['test-hook-a'])
    );

    const req = makeReq({ 'x-snaglet-child-dispatch-token': capped });
    toolDispatchAuthMiddleware(req, makeRes(), jest.fn());
    expect(req.childDispatchUnattendedCap).toBe(true);
    const plain = makeReq({
      'x-snaglet-child-dispatch-token': mintChildDispatchToken('agent-a', 'test-hook-a', 1, [
        'test-hook-a',
      ]),
    });
    toolDispatchAuthMiddleware(plain, makeRes(), jest.fn());
    expect(plain.childDispatchUnattendedCap).toBeUndefined();
  });

  test('a child cannot drop its cap: an edited payload fails the signature', () => {
    const token = mintChildDispatchToken('agent-a', 'test-hook-a', 1, ['test-hook-a'], true);
    const [payload, mac] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const { unattendedCap: _cap, ...uncapped } = decoded;
    const forged = Buffer.from(JSON.stringify(uncapped), 'utf8').toString('base64url');
    expect(verifyChildDispatchToken(`${forged}.${mac}`)).toBeNull();
  });
});

describe('toolDispatchAuthMiddleware', () => {
  test('accepts a valid X-Snaglet-Child-Dispatch-Token, marks scope "child-dispatch", and exposes the bound agentId', () => {
    const req = makeReq({ 'x-snaglet-child-dispatch-token': mintChildDispatchToken('agent-a') });
    const next = jest.fn();
    toolDispatchAuthMiddleware(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.toolExecuteAuthScope).toBe('child-dispatch');
    expect(req.childDispatchAgentId).toBe('agent-a');
  });

  test('a forged/invalid X-Snaglet-Child-Dispatch-Token → 403 (HMAC verify fails, and does not fall back to unauthenticated)', () => {
    const req = makeReq({ 'x-snaglet-child-dispatch-token': 'not-a-real-token' });
    const next = jest.fn();
    toolDispatchAuthMiddleware(req, makeRes(), next);

    expect(next.mock.calls[0][0]).toBeInstanceOf(AppError);
    expect((next.mock.calls[0][0] as AppError).statusCode).toBe(403);
  });

  test("a token forged by relabeling a valid one's payload (different agentId, stale signature) → 403", () => {
    const tokenForA = mintChildDispatchToken('agent-a');
    const [, mac] = tokenForA.split('.');
    const forgedPayload = Buffer.from('agent-b', 'utf8').toString('base64url');
    const forged = `${forgedPayload}.${mac}`;

    const req = makeReq({ 'x-snaglet-child-dispatch-token': forged });
    const next = jest.fn();
    toolDispatchAuthMiddleware(req, makeRes(), next);

    expect(next.mock.calls[0][0]).toBeInstanceOf(AppError);
    expect((next.mock.calls[0][0] as AppError).statusCode).toBe(403);
  });

  test('falls through to full panel-token auth when no child-dispatch header is presented', () => {
    const req = makeReq({ 'x-snaglet-panel-token': getPanelToken() });
    const next = jest.fn();
    toolDispatchAuthMiddleware(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.toolExecuteAuthScope).toBe('panel');
  });

  test('rejects when neither credential is presented — 403, not 404', () => {
    const req = makeReq();
    const next = jest.fn();
    toolDispatchAuthMiddleware(req, makeRes(), next);

    expect(next.mock.calls[0][0]).toBeInstanceOf(AppError);
    expect((next.mock.calls[0][0] as AppError).statusCode).toBe(403);
  });

  test('the child-dispatch token itself is rejected by the strict single-credential panelAuthMiddleware', () => {
    // Proves the two credentials are not interchangeable: a child-dispatch
    // token must never unlock a route gated by panelAuthMiddleware alone
    // (e.g. /execute/test — see tools.routes.ts's mount-order comment).
    const req = makeReq({ 'x-snaglet-child-dispatch-token': mintChildDispatchToken('agent-a') });
    const next = jest.fn();
    panelAuthMiddleware(req, makeRes(), next);

    expect(next.mock.calls[0][0]).toBeInstanceOf(AppError);
    expect((next.mock.calls[0][0] as AppError).statusCode).toBe(403);
  });
});
