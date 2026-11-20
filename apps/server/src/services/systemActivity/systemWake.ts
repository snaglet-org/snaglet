/**
 * System wake detection for the scheduler. A heartbeat every
 * {@link WAKE_HEARTBEAT_MS} notes the wall clock; when the next beat (or a
 * {@link SystemWakeMonitor.check} from the scheduler's tick) finds far more
 * time gone than one beat, the process was suspended: the machine slept and
 * has just woken. Node's timers stand still while the machine sleeps and the
 * wall clock does not, so the gap is the sleep.
 *
 * An activation is when Snaglet last became active: the server start (the
 * monitor's start) or the last wake, whichever is later. The scheduler treats
 * the first minutes after one as a time the network may still be coming back
 * (the network guard, `networkGuard.ts`). A long event-loop stall reads as a
 * wake too; that costs one network probe.
 */
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';

const WAKE_HEARTBEAT_MS = 10_000;
/** A gap longer than one beat plus this is a sleep. */
const WAKE_GAP_MS = 30_000;

export interface SystemActivation {
  /** Epoch milliseconds. */
  at: number;
  reason: 'start' | 'wake';
}

export interface SystemWake {
  /** When it noticed the wake (epoch milliseconds). */
  at: number;
  /** How long the process stood still, about the sleep. */
  sleptMs: number;
}

/** @public Constructed by unit tests with a fake clock; production uses {@link systemWakeMonitor}. */
export interface SystemWakeMonitorOptions {
  now?: () => number;
  heartbeatMs?: number;
  gapMs?: number;
}

/** @public Unit-tested with a fake clock; production uses {@link systemWakeMonitor}. */
export class SystemWakeMonitor {
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly gapMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt: number | null = null;
  private lastBeatAt: number | null = null;
  private lastWakeAt: number | null = null;
  private readonly listeners = new Set<(wake: SystemWake) => void>();

  constructor(options: SystemWakeMonitorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.heartbeatMs = options.heartbeatMs ?? WAKE_HEARTBEAT_MS;
    this.gapMs = options.gapMs ?? WAKE_GAP_MS;
  }

  /** Start the heartbeat; the start is an activation. A second start is a no-op. */
  start(): void {
    if (this.timer) return;
    const now = this.now();
    this.startedAt = now;
    this.lastBeatAt = now;
    this.lastWakeAt = null;
    this.timer = setInterval(() => this.check(), this.heartbeatMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.startedAt = null;
    this.lastBeatAt = null;
    this.lastWakeAt = null;
  }

  /**
   * Note the time `at`. True when the gap since the last note says the
   * machine slept (the listeners hear of it); a clock set back is no wake.
   */
  check(at: number = this.now()): boolean {
    if (this.lastBeatAt === null) return false;
    const gap = at - this.lastBeatAt;
    this.lastBeatAt = at;
    if (gap <= this.heartbeatMs + this.gapMs) return false;
    this.lastWakeAt = at;
    logger.info(`[wake] the machine woke after about ${Math.round(gap / 60_000)} min asleep`);
    for (const listener of this.listeners) {
      try {
        listener({ at, sleptMs: gap });
      } catch (err) {
        logger.warn(`[wake] wake listener failed: ${getErrorMessage(err)}`);
      }
    }
    return true;
  }

  /** When Snaglet last became active (its start or the last wake, the later one); null before a start. */
  lastActivation(): SystemActivation | null {
    if (this.startedAt === null) return null;
    if (this.lastWakeAt !== null && this.lastWakeAt >= this.startedAt) {
      return { at: this.lastWakeAt, reason: 'wake' };
    }
    return { at: this.startedAt, reason: 'start' };
  }

  /** Hear of each wake; returns the unsubscribe. */
  onWake(listener: (wake: SystemWake) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const systemWakeMonitor = new SystemWakeMonitor();
