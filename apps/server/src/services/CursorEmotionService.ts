/**
 * CursorEmotionService — which face an agent's cursor should wear, derived from the chat-stream
 * frames every turn already broadcasts (tapped through WebSocketService.addChannelObserver).
 * The face is drawn by both cursors: the screen overlay (a cursor event carrying `emotion`) and
 * the flower inside web pages (a registered browser sink).
 *
 * Only the RULES table below decides anything; typing and every other frame set no emotion.
 * State is per (agentId, threadId); the agent's emotion is derived: curious if any thread is
 * asking, else thinking if any thread is thinking, else neutral. A change is emitted at once,
 * non-neutral emotions are re-emitted every RENEW_MS (the overlay holds one for 3.5s), and the
 * change back emits one explicit 'neutral'. Nothing here throws into a turn, logs per frame or
 * touches the DB. Clock and timers are injectable for tests.
 */
import type { EmotionId } from '@snaglet/shared/cursor';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { addChannelObserver } from '@server/services/WebSocketService';
import { emitEmotionCursor } from '@server/services/ToolService/tools/system/computer/tool';

type EmotionReason = 'thinking' | 'curious';
export type DerivedEmotion = EmotionReason | 'neutral';

/** The ask tool's id (apps/server/src/services/ToolService/tools/threads/ask/definition.ts). */
const ASK_TOOL_ID = 'ask';
const THINKING_HOLD_MS = 3000;
export const RENEW_MS = 2500;
/** What the page/overlay is asked to hold on each emission (>= RENEW_MS so it never lapses). */
const EMISSION_TTL_MS = 3500;
/** A parked question never outlives the server-side clarification timeout (10 min) by much. */
const ASK_MAX_MS = 11 * 60_000;
const LABEL_MAX = 160;
const DEFAULT_ASK_LABEL = 'Asking you something';

export interface ParsedFrame {
  type: string;
  agentId: string;
  threadId: string;
  payload: Record<string, unknown>;
}

export interface FrameRule {
  /** 'start' (re)starts the reason, 'end' ends it (curious: for the frame's callId only). */
  action: 'start' | 'end';
  reason: EmotionReason;
  /** 'end' of curious: drop every open ask of the matched threads, not just one callId. */
  all?: boolean;
  /** The rule applies only when this holds. */
  when?: (f: ParsedFrame) => boolean;
  /** Label for a curious start (the question text). */
  label?: (f: ParsedFrame) => string | undefined;
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clip = (s: string) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s);

function questionText(source: Record<string, unknown>): string | undefined {
  const qs = Array.isArray(source.questions) ? source.questions : [];
  const first = qs.map((q) => str(rec(q).prompt)).find(Boolean);
  const text = first || str(source.preamble);
  return text ? clip(text.replace(/\s+/g, ' ')) : undefined;
}

const isAskCall = (f: ParsedFrame) => f.payload.toolName === ASK_TOOL_ID;
const endThinking: FrameRule = { action: 'end', reason: 'thinking' };
/** A run that finished or was aborted can no longer be waiting on an answer. */
const endRun: FrameRule[] = [endThinking, { action: 'end', reason: 'curious', all: true }];

/**
 * frame type -> rules. Add a row (or a rule to a row) to give another moment an emotion;
 * frames not listed here are ignored. Thinking ends on the next listed non-thinking frame.
 */
export const CURSOR_EMOTION_RULES: Record<string, FrameRule[]> = {
  'socket:thinking:chunk': [{ action: 'start', reason: 'thinking' }],
  'socket:delta': [endThinking],
  'socket:agent:status': [endThinking],
  'socket:tool:call': [
    endThinking,
    {
      action: 'start',
      reason: 'curious',
      when: isAskCall,
      label: (f) => questionText(rec(f.payload.toolInput)),
    },
  ],
  'socket:clarification:request': [
    endThinking,
    {
      action: 'start',
      reason: 'curious',
      label: (f) => questionText(rec(rec(f.payload).request)),
    },
  ],
  'socket:tool:result': [endThinking, { action: 'end', reason: 'curious' }],
  'socket:clarification:timeout': [{ action: 'end', reason: 'curious' }],
  // Run end / abort frames carry no tool:result for a parked ask; clear it here.
  'socket:done': endRun,
  'socket:chat:aborted': endRun,
};

export interface CursorEmotionDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  /** Overlay cursor (needs a known position; it skips silently otherwise). */
  overlay: (
    agentId: string,
    emotion: EmotionId,
    label?: string,
    update?: 'start' | 'renew' | 'settle'
  ) => void | Promise<void>;
  /** In-page flower. */
  browser: (agentId: string, emotion: EmotionId, ttlMs: number) => void | Promise<void>;
}

type BrowserSink = (agentId: string, emotion: string, ttlMs: number) => void | Promise<void>;
let browserSink: BrowserSink | null = null;
/** Registered at startup so this service never imports the browser controller. */
export function registerBrowserEmotionSink(sink: BrowserSink | null): void {
  browserSink = sink;
}

const defaultDeps = (): CursorEmotionDeps => ({
  now: Date.now,
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  overlay: (agentId, emotion, label, update) => emitEmotionCursor(agentId, emotion, label, update),
  browser: (agentId, emotion, ttl) => browserSink?.(agentId, emotion, ttl),
});

interface ThreadState {
  agentId: string;
  threadId: string;
  thinkingUntil: number;
  thinkTimer?: unknown;
  /** callId -> open ask */
  asks: Map<string, { label?: string; at: number }>;
}

interface AgentEmit {
  key: string;
  timer?: unknown;
}

export class CursorEmotionService {
  private readonly deps: CursorEmotionDeps;
  private threads = new Map<string, ThreadState>();
  private emitted = new Map<string, AgentEmit>();

  constructor(deps: Partial<CursorEmotionDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  /** Observer entry point: a channel broadcast (the channel is the thread id). */
  observe(message: { type?: string; payload?: unknown }, channel: string): void {
    try {
      const rules = message.type ? CURSOR_EMOTION_RULES[message.type] : undefined;
      if (!rules || !channel) return;
      const payload = rec(message.payload);
      const frame: ParsedFrame = {
        type: message.type as string,
        agentId: str(payload.agentId),
        threadId: channel,
        payload,
      };
      const touched = new Set<string>();
      for (const rule of rules) {
        if (rule.when && !rule.when(frame)) continue;
        this.apply(rule, frame, touched);
      }
      for (const agentId of touched) this.refresh(agentId);
    } catch {
      /* never throw into a turn */
    }
  }

  private threadOf(agentId: string, threadId: string): ThreadState {
    const key = `${agentId}\u0000${threadId}`;
    let t = this.threads.get(key);
    if (!t) {
      t = { agentId, threadId, thinkingUntil: 0, asks: new Map() };
      this.threads.set(key, t);
    }
    return t;
  }

  /** Threads a frame concerns: the agent's own when the frame names it, else every agent's. */
  private matching(f: ParsedFrame): ThreadState[] {
    const out: ThreadState[] = [];
    for (const t of this.threads.values()) {
      if (t.threadId === f.threadId && (!f.agentId || t.agentId === f.agentId)) out.push(t);
    }
    return out;
  }

  private apply(rule: FrameRule, f: ParsedFrame, touched: Set<string>): void {
    const callId = str(f.payload.callId);
    if (rule.action === 'start') {
      if (!f.agentId) return;
      const t = this.threadOf(f.agentId, f.threadId);
      touched.add(f.agentId);
      if (rule.reason === 'thinking') {
        t.thinkingUntil = this.deps.now() + THINKING_HOLD_MS;
        this.armThinking(t);
      } else {
        const label = rule.label?.(f);
        const prev = t.asks.get(callId || '_');
        t.asks.set(callId || '_', { label: label ?? prev?.label, at: prev?.at ?? this.deps.now() });
      }
      return;
    }
    for (const t of this.matching(f)) {
      if (rule.reason === 'thinking') {
        if (t.thinkingUntil === 0) continue;
        t.thinkingUntil = 0;
        this.clearThinkTimer(t);
        touched.add(t.agentId);
      } else if (rule.all) {
        if (t.asks.size === 0) continue;
        t.asks.clear();
        touched.add(t.agentId);
      } else if (callId && t.asks.delete(callId)) {
        touched.add(t.agentId);
      }
    }
  }

  private clearThinkTimer(t: ThreadState): void {
    if (t.thinkTimer) this.deps.clearTimer(t.thinkTimer);
    t.thinkTimer = undefined;
  }

  /** One timer per thread, aimed at thinkingUntil; chunks only move the deadline. */
  private armThinking(t: ThreadState): void {
    if (t.thinkTimer) return;
    const wait = Math.max(0, t.thinkingUntil - this.deps.now());
    t.thinkTimer = this.deps.setTimer(() => {
      t.thinkTimer = undefined;
      if (t.thinkingUntil > this.deps.now()) return this.armThinking(t);
      t.thinkingUntil = 0;
      this.refresh(t.agentId);
    }, wait);
  }

  private derive(agentId: string): { emotion: DerivedEmotion; label?: string } {
    const now = this.deps.now();
    let thinking = false;
    let ask: { label?: string; at: number } | undefined;
    for (const [key, t] of this.threads) {
      if (t.agentId !== agentId) continue;
      for (const [id, a] of t.asks) if (now - a.at > ASK_MAX_MS) t.asks.delete(id);
      for (const a of t.asks.values()) if (!ask || a.at >= ask.at) ask = a;
      if (t.thinkingUntil > now) thinking = true;
      else if (t.asks.size === 0 && !t.thinkTimer) this.threads.delete(key);
    }
    if (ask) return { emotion: 'curious', label: ask.label ?? DEFAULT_ASK_LABEL };
    return { emotion: thinking ? 'thinking' : 'neutral' };
  }

  /** Recompute the agent's emotion; emit on change and keep renewing while it holds. */
  private refresh(agentId: string): void {
    const { emotion, label } = this.derive(agentId);
    const key = `${emotion}|${label ?? ''}`;
    const prev = this.emitted.get(agentId);
    if ((prev?.key ?? 'neutral|') === key) return;
    if (prev?.timer) this.deps.clearTimer(prev.timer);
    if (emotion === 'neutral') {
      this.emitted.delete(agentId);
      this.emit(agentId, 'neutral', undefined, 'settle');
      return;
    }
    const entry: AgentEmit = { key };
    this.emitted.set(agentId, entry);
    this.emit(agentId, emotion, label, 'start');
    const tick = () => {
      const cur = this.derive(agentId);
      if (`${cur.emotion}|${cur.label ?? ''}` !== entry.key) return this.refresh(agentId);
      this.emit(agentId, cur.emotion as EmotionReason, cur.label, 'renew');
      entry.timer = this.deps.setTimer(tick, RENEW_MS);
    };
    entry.timer = this.deps.setTimer(tick, RENEW_MS);
  }

  private emit(
    agentId: string,
    emotion: EmotionId,
    label: string | undefined,
    update: 'start' | 'renew' | 'settle'
  ): void {
    const settle = (r: void | Promise<void>) => {
      if (r && typeof (r as Promise<void>).catch === 'function')
        (r as Promise<void>).catch((err: unknown) =>
          logger.debug(`[cursor-emotion] sink failed: ${getErrorMessage(err)}`)
        );
    };
    try {
      settle(this.deps.overlay(agentId, emotion, label, update));
    } catch {
      /* best effort */
    }
    try {
      settle(this.deps.browser(agentId, emotion, EMISSION_TTL_MS));
    } catch {
      /* best effort */
    }
  }
}

const cursorEmotionService = new CursorEmotionService();

let started = false;
/** Hook the service onto the channel broadcast tap. Idempotent. */
export function startCursorEmotionService(): void {
  if (started) return;
  started = true;
  addChannelObserver((m, channel) => cursorEmotionService.observe(m, channel));
}
