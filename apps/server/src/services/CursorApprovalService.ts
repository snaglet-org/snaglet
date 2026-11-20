/**
 * CursorApprovalService — asks the user to allow an agent to take the real
 * cursor. One pending request per agent; "allow-session" remembers the agent
 * for a while. Clock and broadcast are injectable so tests need no timers or sockets.
 */
import { generateId } from '@snaglet/shared/utils';
import {
  AGENT_CURSOR_REQUEST_EVENT,
  AGENT_CURSOR_REQUEST_RESOLVED_EVENT,
} from '@snaglet/shared/constants/agentCursor';
import type {
  AgentCursorRequestEvent,
  AgentCursorRequestResolvedEvent,
  CursorApprovalDecision,
  CursorFlower,
} from '@snaglet/shared/constants/agentCursor';
import { wsService } from '@server/services/WebSocketService';

export type ApprovalOutcome = CursorApprovalDecision | 'timeout';

export interface ApprovalRequestInput {
  agentId: string;
  name: string;
  reason?: string;
  flower: CursorFlower;
  color: string;
  /** What is being approved. Absent means the desktop cursor. */
  kind?: 'cursor' | 'browser' | 'handoff';
  /** For kind 'browser': the profile the agent wants to use. */
  profile?: string;
  /** Overrides the default request timeout (handoffs wait for a human). */
  timeoutMs?: number;
}

/** Grant/pending key: the cursor is per agent, the browser per (agent, profile). */
const grantKey = (agentId: string, profile?: string) =>
  profile ? `${agentId}::browser:${profile}` : agentId;

export interface CursorApprovalDeps {
  now: () => number;
  broadcast: (msg: { type: string; payload: unknown }) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  timeoutMs: () => number;
  sessionMs: () => number;
}

const envMs = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const approvalRequired = () => process.env.SNAGLET_COMPUTER_REQUIRE_APPROVAL !== '0';
export const browserApprovalRequired = () => process.env.SNAGLET_BROWSER_REQUIRE_APPROVAL !== '0';

const defaultDeps = (): CursorApprovalDeps => ({
  now: Date.now,
  broadcast: (m) => wsService.broadcast(m as never),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  timeoutMs: () => envMs('SNAGLET_COMPUTER_APPROVAL_TIMEOUT_MS', 45_000),
  sessionMs: () => envMs('SNAGLET_COMPUTER_SESSION_GRANT_MS', 30 * 60_000),
});

interface Pending {
  agentId: string;
  key: string;
  promise: Promise<ApprovalOutcome>;
  finish: (o: ApprovalOutcome) => void;
}

export class CursorApprovalService {
  private pending = new Map<string, Pending>(); // requestId -> pending
  private grants = new Map<string, number>(); // agentId -> expiresAt
  private readonly deps: CursorApprovalDeps;

  constructor(deps: Partial<CursorApprovalDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  hasSessionGrant(agentId: string, profile?: string): boolean {
    const key = grantKey(agentId, profile);
    const exp = this.grants.get(key);
    if (exp === undefined) return false;
    if (exp <= this.deps.now()) {
      this.grants.delete(key);
      return false;
    }
    return true;
  }

  /** Live session grants with seconds left. */
  sessionGrants(): Array<{ agentId: string; profile?: string; expiresInSec: number }> {
    return [...this.grants.keys()].flatMap((key) => {
      const [agentId, profile] = key.split('::browser:');
      if (!this.hasSessionGrant(agentId, profile)) return [];
      return [
        {
          agentId,
          ...(profile ? { profile } : {}),
          expiresInSec: Math.max(0, Math.ceil((this.grants.get(key)! - this.deps.now()) / 1000)),
        },
      ];
    });
  }

  /** Kill switch: drop every session grant and cancel pending prompts. */
  revokeAll(): void {
    this.grants.clear();
    for (const p of [...this.pending.values()]) p.finish('deny');
  }

  isPending(agentId: string): boolean {
    return [...this.pending.values()].some((p) => p.agentId === agentId);
  }

  requestApproval(input: ApprovalRequestInput): Promise<ApprovalOutcome> {
    const key =
      input.kind === 'handoff'
        ? `${input.agentId}::handoff`
        : grantKey(input.agentId, input.kind === 'browser' ? input.profile : undefined);
    const existing = [...this.pending.values()].find((p) => p.key === key);
    if (existing) return existing.promise;

    const requestId = generateId('req');
    const timeoutMs = input.timeoutMs ?? this.deps.timeoutMs();
    let finish!: (o: ApprovalOutcome) => void;
    const promise = new Promise<ApprovalOutcome>((resolve) => {
      let done = false;
      const timer = this.deps.setTimer(() => finish('timeout'), timeoutMs);
      finish = (outcome) => {
        if (done) return;
        done = true;
        this.deps.clearTimer(timer);
        this.pending.delete(requestId);
        if (outcome === 'allow-session' && input.kind !== 'handoff') {
          this.grants.set(key, this.deps.now() + this.deps.sessionMs());
        }
        const payload: AgentCursorRequestResolvedEvent = { requestId, decision: outcome };
        this.deps.broadcast({ type: AGENT_CURSOR_REQUEST_RESOLVED_EVENT, payload });
        resolve(outcome);
      };
    });
    this.pending.set(requestId, { agentId: input.agentId, key, promise, finish });
    const payload: AgentCursorRequestEvent = {
      requestId,
      ...(input.kind === 'browser' ? { kind: 'browser' as const, profile: input.profile } : {}),
      ...(input.kind === 'handoff' ? { kind: 'handoff' as const } : {}),
      agentId: input.agentId,
      name: input.name,
      flower: input.flower,
      color: input.color,
      reason: input.reason,
      expiresAt: this.deps.now() + timeoutMs,
    };
    this.deps.broadcast({ type: AGENT_CURSOR_REQUEST_EVENT, payload });
    return promise;
  }

  resolveApproval(requestId: string, decision: CursorApprovalDecision): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    p.finish(decision);
    return true;
  }
}

export const cursorApprovalService = new CursorApprovalService();
