/**
 * CursorClaimService — single in-memory holder of the machine's real cursor.
 * One agent at a time; a lease (renewed by every action) keeps a crashed or
 * forgetful agent from holding it forever.
 */

export const CURSOR_LEASE_MS = 120_000;

export type ClaimResult =
  | { ok: true; holder: 'you'; expiresInSec: number }
  | { ok: false; busy: true; holder: string; retryAfter: number; message: string };

interface Holder {
  agentId: string;
  name: string;
  reason?: string;
  expiresAt: number;
  lastActionAt: number;
  claimId: number;
}

export class CursorClaimService {
  private holder: Holder | null = null;
  private claimCounter = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private current(): Holder | null {
    if (this.holder && this.holder.expiresAt <= this.now()) this.holder = null;
    return this.holder;
  }

  /** Agent id of the live holder, or null when free. */
  holderAgentId(): string | null {
    return this.current()?.agentId ?? null;
  }

  holderInfo(): { agentId: string; name: string; reason?: string; expiresInSec: number } | null {
    const h = this.current();
    if (!h) return null;
    return {
      agentId: h.agentId,
      name: h.name,
      reason: h.reason,
      expiresInSec: Math.max(0, Math.ceil((h.expiresAt - this.now()) / 1000)),
    };
  }

  /** Cheap read-only snapshot for the native overlay (no names, no side effects). */
  state(now: number = this.now()): {
    claimed: boolean;
    agentId: string | null;
    claimId: number | null;
    lastActionAgeMs: number | null;
  } {
    const h = this.holder;
    if (!h || h.expiresAt <= now)
      return { claimed: false, agentId: null, claimId: null, lastActionAgeMs: null };
    return {
      claimed: true,
      agentId: h.agentId,
      claimId: h.claimId,
      lastActionAgeMs: Math.max(0, now - h.lastActionAt),
    };
  }

  /** Busy reply for a caller that is not the holder, or null when it may proceed. */
  busyFor(agentId: string): Extract<ClaimResult, { ok: false }> | null {
    const h = this.current();
    if (!h || h.agentId === agentId) return null;
    return this.busy(h);
  }

  private busy(h: Holder): Extract<ClaimResult, { ok: false }> {
    return {
      ok: false,
      busy: true,
      holder: h.name,
      retryAfter: Math.max(1, Math.ceil((h.expiresAt - this.now()) / 1000)),
      message: `${h.name} is using the cursor. Wait your turn.`,
    };
  }

  claim(agentId: string, agentName: string, reason?: string): ClaimResult {
    const h = this.current();
    if (h && h.agentId !== agentId) return this.busy(h);
    // A fresh claim (not a renew by the current holder) gets a new id.
    const claimId = h ? h.claimId : ++this.claimCounter;
    this.holder = {
      claimId,
      agentId,
      name: agentName,
      reason,
      expiresAt: this.now() + CURSOR_LEASE_MS,
      lastActionAt: this.now(),
    };
    return { ok: true, holder: 'you', expiresInSec: CURSOR_LEASE_MS / 1000 };
  }

  /** Extend the lease; only the holder may renew. */
  renew(agentId: string): boolean {
    const h = this.current();
    if (!h || h.agentId !== agentId) return false;
    h.expiresAt = this.now() + CURSOR_LEASE_MS;
    h.lastActionAt = this.now();
    return true;
  }

  release(agentId: string): boolean {
    const h = this.current();
    if (!h || h.agentId !== agentId) return false;
    this.holder = null;
    return true;
  }

  /** Kill switch: drop the claim whoever holds it. Returns the former holder. */
  revoke(): { agentId: string; name: string } | null {
    const h = this.current();
    this.holder = null;
    return h ? { agentId: h.agentId, name: h.name } : null;
  }
}

export const cursorClaimService = new CursorClaimService();
