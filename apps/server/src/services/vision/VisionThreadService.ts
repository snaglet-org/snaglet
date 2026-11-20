import type {
  VisionPreviewClearPayload,
  VisionPreviewFramePayload,
  VisionSessionPhase,
  VisionSessionStatePayload,
} from '@snaglet/shared/types';
import { logger } from '@server/config/logger';
import {
  emitThreadVisionPreview,
  emitThreadVisionPreviewClear,
  emitThreadVisionState,
} from '@server/realtime/surfaces/threads';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  VisionSnapshotService,
  visionSnapshotService,
  type VisionCaptureSource,
  type VisionFrameSource,
  type VisionScreenCaptureOptions,
  type VisionSnapshotSession,
  type VisionTemporaryFrame,
} from './VisionSnapshotService';
import { browserVisionCaptureService } from './BrowserVisionCaptureService';
import { VisionCaptureError, describeVisionCaptureFailure } from './visionCaptureErrors';

export interface VisionThreadRuntime {
  createSession(): Promise<VisionSnapshotSession>;
  captureFrame(
    session: VisionSnapshotSession,
    source: VisionFrameSource,
    options?: VisionScreenCaptureOptions,
    signal?: AbortSignal
  ): Promise<{ frame: VisionTemporaryFrame; data: Buffer }>;
  storeFrame(
    session: VisionSnapshotSession,
    source: VisionFrameSource,
    data: Buffer
  ): Promise<{ frame: VisionTemporaryFrame; data: Buffer }>;
  readFrame(frame: VisionTemporaryFrame): Promise<Buffer>;
  deleteFrame(frame: VisionTemporaryFrame): Promise<void>;
  deleteSession(session: VisionSnapshotSession): Promise<void>;
  cleanupAbandonedSessions(): Promise<string[]>;
}

export interface VisionThreadStatus {
  enabled: boolean;
  threadId: string;
  source: VisionCaptureSource | null;
  sessionId: string | null;
  sessionDir: string | null;
  temporaryFrameCount: number;
}

export interface VisionOnDemandCapture {
  frameId: string;
  sessionId: string;
  source: VisionFrameSource;
  capturedAt: string;
  mediaType: 'image/jpeg' | 'image/png';
  byteLength: number;
  base64: string;
  reused: boolean;
  deliveryUrl: string;
  expiresAt: string;
}

interface TemporaryFrameEntry {
  frame: VisionTemporaryFrame;
  turnKey: string;
  ownerUserId: string;
  data: Buffer;
}

interface ActiveThreadVision {
  threadId: string;
  source: VisionCaptureSource;
  session: VisionSnapshotSession;
  frames: Map<string, TemporaryFrameEntry>;
  /** null means this turn already used its one frame and no temp bytes remain. */
  turnCaptures: Map<string, string | null>;
  captureClientId: string;
}

interface VisionTransition {
  phase: Exclude<VisionSessionPhase, 'inactive' | 'active'>;
  source: VisionCaptureSource | null;
  error: string | null;
}

/**
 * How this agent's view of vision access changed since its previous turn.
 * `enabled` also covers an agent that joined (or woke) while access was
 * already on — from its perspective the grant is news either way.
 */
type VisionAccessTransitionKind = 'enabled' | 'source-changed' | 'revoked';

/**
 * A point-in-time view of one thread's vision access. Used for three distinct
 * roles: what an agent has ACKNOWLEDGED, the CANDIDATE built into one model
 * attempt's payload, and the CONFIRMED candidate of an attempt the provider
 * actually accepted.
 */
export interface VisionAccessSnapshot {
  version: number;
  source: VisionCaptureSource | null;
}

type VisionAccessSeen = VisionAccessSnapshot;

export interface VisionAccessDelta {
  /** Monotonic per thread; bumped on every real access change. */
  version: number;
  /** Null when access is active and unchanged since this agent last looked. */
  transition: {
    kind: VisionAccessTransitionKind;
    source: VisionCaptureSource | null;
    priorSource: VisionCaptureSource | null;
  } | null;
  /** Current access, or null when vision is off. */
  current: VisionCaptureSource | null;
}

function sourceAllowed(access: VisionCaptureSource, requested: VisionFrameSource): boolean {
  return access === 'both' || access === requested;
}

function turnKey(agentId: string, turnId: string): string {
  return `${agentId}:${turnId}`;
}

const productionRuntime: VisionThreadRuntime = {
  createSession: () => visionSnapshotService.createSession(),
  captureFrame: (session, source, options, signal) =>
    visionSnapshotService.captureFrame(session, source, options, signal),
  storeFrame: (session, source, data) => visionSnapshotService.storeFrame(session, source, data),
  readFrame: (frame) => visionSnapshotService.readFrame(frame),
  deleteFrame: (frame) => visionSnapshotService.deleteFrame(frame),
  deleteSession: (session) => visionSnapshotService.deleteSession(session),
  cleanupAbandonedSessions: () => visionSnapshotService.cleanupAbandonedSessions(),
};

export class VisionThreadService {
  private readonly active = new Map<string, ActiveThreadVision>();
  private readonly transitions = new Map<string, VisionTransition>();
  private readonly operations = new Map<string, Promise<void>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Agent-perceivable access transitions.
   *
   * Deliberately not a queue. The delta is derived by comparing what an agent
   * last acknowledged against current state, which makes a read idempotent:
   * the same turn re-read across a provider retry or a model fallback yields
   * identical bytes, and two changes between one agent's turns coalesce into
   * one truthful statement rather than a backlog it has to reconcile.
   *
   * In-memory only, matching the rest of vision access — a grant does not
   * survive a restart, so neither should the memory of one.
   */
  private readonly accessVersion = new Map<string, number>();
  private readonly accessSeen = new Map<string, Map<string, VisionAccessSeen>>();

  /**
   * The snapshot of an attempt the provider actually ACCEPTED, per
   * (thread, agent). Drained at turn completion.
   *
   * Two distinctions this encodes, both of which cost a lost transition when
   * collapsed:
   *
   *  - Acknowledging CURRENT state at teardown is wrong: the user can revoke
   *    while the provider is still responding, and retiring that newer state
   *    would bury a revocation the agent was never told about.
   *  - Acknowledging what was merely ASSEMBLED is also wrong: building a
   *    payload is not the model receiving it. If every attempt fails, nothing
   *    was perceived and the transition must still be pending next turn.
   *
   * So the candidate lives with the attempt that built it (carried on
   * ModelAttemptContext) and only reaches here when that specific attempt gets
   * a successful provider result.
   */
  private readonly accessConfirmed = new Map<string, Map<string, VisionAccessSnapshot>>();

  constructor(
    private readonly runtime: VisionThreadRuntime = productionRuntime,
    private readonly emitState: (state: VisionSessionStatePayload) => void = emitThreadVisionState,
    private readonly emitPreview: (
      frame: VisionPreviewFramePayload
    ) => void = emitThreadVisionPreview,
    private readonly emitPreviewClear: (
      payload: VisionPreviewClearPayload
    ) => void = emitThreadVisionPreviewClear,
    private readonly captureBrowserFrame: (
      clientId: string,
      threadId: string,
      source: 'screen' | 'camera',
      signal?: AbortSignal
    ) => Promise<Buffer> = (clientId, threadId, source, signal) =>
      browserVisionCaptureService.request(clientId, threadId, source, signal)
  ) {}

  startExpirySweep(intervalMs = 5_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweepExpiredFrames(), intervalMs);
    this.sweepTimer.unref?.();
  }

  stopExpirySweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  async start(
    threadId: string,
    source: VisionCaptureSource = 'screen',
    captureClientId = ''
  ): Promise<VisionThreadStatus> {
    return this.serialize(threadId, () => this.startNow(threadId, source, captureClientId));
  }

  private async startNow(
    threadId: string,
    source: VisionCaptureSource,
    captureClientId: string
  ): Promise<VisionThreadStatus> {
    const current = this.active.get(threadId);
    if (current?.source === source) {
      if (captureClientId) current.captureClientId = captureClientId;
      this.emitCurrentState(threadId);
      return this.status(threadId);
    }

    this.transitions.set(threadId, { phase: 'starting', source, error: null });
    this.emitCurrentState(threadId);
    try {
      if (current) {
        await this.clearAllFrames(current);
        current.source = source;
        if (captureClientId) current.captureClientId = captureClientId;
        this.bumpAccessVersion(threadId);
        this.transitions.delete(threadId);
        logger.info(
          `[vision] access source switched thread=${threadId} session=${current.session.sessionId} source=${source}`
        );
        this.emitCurrentState(threadId);
        return this.status(threadId);
      }

      const session = await this.runtime.createSession();
      this.active.set(threadId, {
        threadId,
        source,
        session,
        frames: new Map(),
        turnCaptures: new Map(),
        captureClientId,
      });
      this.bumpAccessVersion(threadId);
      this.transitions.delete(threadId);
      logger.info(
        `[vision] on-demand access started thread=${threadId} source=${source} session=${session.sessionId}`
      );
      this.emitCurrentState(threadId);
      return this.status(threadId);
    } catch (error) {
      const message = getErrorMessage(error);
      this.transitions.set(threadId, { phase: 'error', source, error: message });
      this.emitCurrentState(threadId);
      throw error;
    }
  }

  async stop(threadId: string): Promise<VisionThreadStatus> {
    return this.serialize(threadId, () => this.stopNow(threadId));
  }

  private async stopNow(threadId: string): Promise<VisionThreadStatus> {
    const current = this.active.get(threadId);
    if (!current) {
      this.transitions.delete(threadId);
      this.emitCurrentState(threadId);
      return this.disabledStatus(threadId);
    }
    this.transitions.set(threadId, { phase: 'stopping', source: current.source, error: null });
    this.emitCurrentState(threadId);
    this.active.delete(threadId);
    try {
      await this.runtime.deleteSession(current.session);
    } catch (error) {
      this.active.set(threadId, current);
      const message = getErrorMessage(error);
      this.transitions.set(threadId, { phase: 'error', source: current.source, error: message });
      this.emitCurrentState(threadId);
      throw error;
    }
    for (const entry of current.frames.values()) this.emitFrameCleared(current, entry.frame);
    current.frames.clear();
    current.turnCaptures.clear();
    this.bumpAccessVersion(threadId);
    this.transitions.delete(threadId);
    logger.info(
      `[vision] on-demand access stopped thread=${threadId} session=${current.session.sessionId}`
    );
    this.emitCurrentState(threadId);
    return this.disabledStatus(threadId);
  }

  async stopAll(): Promise<void> {
    const threadIds = new Set([...this.active.keys(), ...this.operations.keys()]);
    await Promise.all([...threadIds].map((threadId) => this.stop(threadId)));
  }

  /** Startup crash recovery. Call before accepting any new vision sessions. */
  async cleanupAbandonedSessions(): Promise<string[]> {
    const removed = await this.runtime.cleanupAbandonedSessions();
    if (removed.length > 0) {
      logger.info(`[vision] removed ${removed.length} abandoned temporary session(s)`);
    }
    return removed;
  }

  status(threadId: string): VisionThreadStatus {
    const current = this.active.get(threadId);
    if (!current) return this.disabledStatus(threadId);
    return {
      enabled: true,
      threadId,
      source: current.source,
      sessionId: current.session.sessionId,
      sessionDir: current.session.sessionDir,
      temporaryFrameCount: current.frames.size,
    };
  }

  sessionState(threadId: string): VisionSessionStatePayload {
    const transition = this.transitions.get(threadId);
    const current = this.active.get(threadId);
    const source = transition?.source ?? current?.source ?? null;
    const phase = transition?.phase ?? (current ? 'active' : 'inactive');
    return {
      threadId,
      phase,
      enabled: Boolean(current) || phase === 'starting' || phase === 'stopping',
      source,
      sessionId: current?.session.sessionId ?? null,
      sessionDir: current?.session.sessionDir ?? null,
      // Ready now means access is granted and the on-demand session directory
      // exists. It never means a background frame has arrived.
      ready: Boolean(current) && phase !== 'stopping',
      error: transition?.error ?? null,
      updatedAt: new Date().toISOString(),
    };
  }

  emitCurrentState(threadId: string): VisionSessionStatePayload {
    const state = this.sessionState(threadId);
    this.emitState(state);
    return state;
  }

  private bumpAccessVersion(threadId: string): void {
    this.accessVersion.set(threadId, (this.accessVersion.get(threadId) ?? 0) + 1);
  }

  /**
   * What this agent needs told about vision access this turn, derived from the
   * gap between what it last acknowledged and current state.
   *
   * Read-only and idempotent by construction — calling it twice in one turn
   * (model fallback re-runs context assembly) returns the same thing, because
   * nothing is consumed until `markAccessSeen` runs at turn completion.
   *
   * Returns null when there is genuinely nothing to say: vision is off and
   * this agent never saw it on.
   */
  accessDeltaFor(threadId: string, agentId: string): VisionAccessDelta | null {
    const current = this.active.get(threadId)?.source ?? null;
    const version = this.accessVersion.get(threadId) ?? 0;
    const seen = this.accessSeen.get(threadId)?.get(agentId);

    if (!seen) {
      // Never observed this thread's vision access. An agent that joined or
      // woke while access was already on is told it is on — from its point of
      // view that is the enable transition.
      if (current === null) return null;
      return {
        version,
        transition: { kind: 'enabled', source: current, priorSource: null },
        current,
      };
    }

    if (seen.source === current) {
      // Steady state: a snapshot while active, silence while off, so a
      // revocation is not repeated on every subsequent clean turn.
      return current === null ? null : { version, transition: null, current };
    }
    if (current === null) {
      return {
        version,
        transition: { kind: 'revoked', source: null, priorSource: seen.source },
        current: null,
      };
    }
    if (seen.source === null) {
      return {
        version,
        transition: { kind: 'enabled', source: current, priorSource: null },
        current,
      };
    }
    return {
      version,
      transition: { kind: 'source-changed', source: current, priorSource: seen.source },
      current,
    };
  }

  /**
   * The snapshot to carry on ONE model attempt's context. Pure — it claims
   * nothing about delivery, because at assembly time nothing has been.
   */
  accessCandidateFrom(delta: VisionAccessDelta): VisionAccessSnapshot {
    return { version: delta.version, source: delta.current };
  }

  /**
   * Confirm that THIS attempt's candidate reached the model — call only once
   * the provider has returned a successful result (text or tool calls), before
   * any tool executes.
   *
   * Ownership is explicit rather than positional: a failed attempt's candidate
   * never arrives here, so a later fallback that succeeds confirms its own
   * snapshot and the failed one is simply forgotten. Last successful attempt
   * wins, which is the one the model actually read.
   */
  confirmAccessDelivered(
    threadId: string,
    agentId: string,
    candidate: VisionAccessSnapshot | null | undefined
  ): void {
    if (!candidate) return;
    let perAgent = this.accessConfirmed.get(threadId);
    if (!perAgent) {
      perAgent = new Map();
      this.accessConfirmed.set(threadId, perAgent);
    }
    perAgent.set(agentId, candidate);
  }

  /**
   * Acknowledge — at guaranteed logical-turn completion — only a snapshot some
   * attempt actually got in front of the model.
   *
   * A no-op when nothing was confirmed, which covers the turn that died before
   * context assembly, the turn whose every provider attempt failed, and the
   * abort before first success. Acknowledging any of those would retire a
   * transition nobody ever perceived.
   */
  markAccessSeen(threadId: string, agentId: string): void {
    const confirmedForThread = this.accessConfirmed.get(threadId);
    const confirmed = confirmedForThread?.get(agentId);
    if (!confirmedForThread || !confirmed) return;

    confirmedForThread.delete(agentId);
    if (confirmedForThread.size === 0) this.accessConfirmed.delete(threadId);

    let perAgent = this.accessSeen.get(threadId);
    if (confirmed.source === null) {
      // Acknowledging "off" carries no future information: an agent with no
      // record and an agent that acknowledged null both get silence next turn.
      // Dropping the entry keeps this map from growing per agent per thread.
      if (perAgent) {
        perAgent.delete(agentId);
        if (perAgent.size === 0) this.accessSeen.delete(threadId);
      }
      return;
    }
    if (!perAgent) {
      perAgent = new Map();
      this.accessSeen.set(threadId, perAgent);
    }
    perAgent.set(agentId, confirmed);
  }

  async captureOnDemand(input: {
    threadId: string;
    agentId: string;
    turnId: string;
    source: VisionFrameSource;
    ownerUserId: string;
    screen?: VisionScreenCaptureOptions;
    signal?: AbortSignal;
  }): Promise<VisionOnDemandCapture> {
    return this.serialize(input.threadId, async () => {
      const current = this.active.get(input.threadId);
      if (!current) {
        throw new VisionCaptureError(
          'access_off',
          describeVisionCaptureFailure('access_off', input.source),
          null
        );
      }
      if (!sourceAllowed(current.source, input.source)) {
        throw new VisionCaptureError(
          'source_not_granted',
          `${describeVisionCaptureFailure('source_not_granted', input.source)} Current source is ${current.source}.`,
          current.source
        );
      }
      const key = turnKey(input.agentId, input.turnId);
      if (current.turnCaptures.has(key)) {
        const existingId = current.turnCaptures.get(key);
        if (!existingId) {
          throw new Error(
            'The one temporary vision frame for this turn was already used and is no longer available.'
          );
        }
        const existing = current.frames.get(existingId);
        if (!existing) throw new Error('The temporary vision frame is no longer available.');
        return this.capturePayload(current, existing.frame, existing.data, true);
      }

      // Both sources come from the Snaglet window that granted access: it already
      // holds the getDisplayMedia / getUserMedia streams, and that is the one
      // capture path that behaves the same on macOS and Windows. The native
      // snapshot runtime is never consulted for a camera frame.
      const captured = await this.runtime.storeFrame(
        current.session,
        input.source,
        await this.captureBrowserFrame(
          current.captureClientId,
          input.threadId,
          input.source,
          input.signal
        )
      );
      current.frames.set(captured.frame.id, {
        frame: captured.frame,
        turnKey: key,
        ownerUserId: input.ownerUserId,
        data: captured.data,
      });
      current.turnCaptures.set(key, captured.frame.id);
      const payload = this.capturePayload(current, captured.frame, captured.data, false);
      this.emitPreview({
        threadId: input.threadId,
        sessionId: current.session.sessionId,
        frameId: captured.frame.id,
        source: captured.frame.source,
        frameTs: captured.frame.capturedAt,
        mimeType: captured.frame.mimeType,
        deliveryUrl: payload.deliveryUrl,
        expiresAt: payload.expiresAt,
        byteLength: captured.frame.byteLength,
        updatedAt: new Date().toISOString(),
      });
      logger.info(
        `[vision] on-demand frame captured thread=${input.threadId} agent=${input.agentId} ` +
          `source=${input.source} frame=${captured.frame.id}`
      );
      return payload;
    });
  }

  getFrameForDelivery(input: {
    threadId: string;
    sessionId: string;
    frameId: string;
    userId: string;
  }):
    | { status: 'ok'; frame: VisionTemporaryFrame; data: Buffer }
    | { status: 'missing' | 'expired' } {
    const current = this.active.get(input.threadId);
    if (!current || current.session.sessionId !== input.sessionId) return { status: 'missing' };
    const entry = current.frames.get(input.frameId);
    if (!entry || entry.ownerUserId !== input.userId) return { status: 'missing' };
    if (Date.parse(entry.frame.expiresAt) <= Date.now()) {
      void this.expireFrame(current, entry);
      return { status: 'expired' };
    }
    return { status: 'ok', frame: entry.frame, data: entry.data };
  }

  async sweepExpiredFrames(now = Date.now()): Promise<void> {
    for (const current of this.active.values()) {
      const expired = [...current.frames.values()].filter(
        ({ frame }) => Date.parse(frame.expiresAt) <= now
      );
      for (const entry of expired) await this.expireFrame(current, entry);
    }
  }

  private deliveryUrl(current: ActiveThreadVision, frame: VisionTemporaryFrame): string {
    return `/api/vision/frames/${encodeURIComponent(current.threadId)}/${encodeURIComponent(current.session.sessionId)}/${encodeURIComponent(frame.id)}`;
  }

  private async expireFrame(
    current: ActiveThreadVision,
    entry: TemporaryFrameEntry
  ): Promise<void> {
    if (!current.frames.delete(entry.frame.id)) return;
    if (current.turnCaptures.get(entry.turnKey) === entry.frame.id) {
      current.turnCaptures.set(entry.turnKey, null);
    }
    await this.runtime.deleteFrame(entry.frame);
    this.emitFrameCleared(current, entry.frame);
  }

  /** Delete every unpromoted frame owned by this agent turn on any exit path. */
  async releaseTurnFrames(threadId: string, agentId: string, turnId: string): Promise<void> {
    await this.serialize(threadId, async () => {
      const current = this.active.get(threadId);
      if (!current) return;
      const key = turnKey(agentId, turnId);
      const frameId = current.turnCaptures.get(key);
      current.turnCaptures.delete(key);
      if (!frameId) return;
      const entry = current.frames.get(frameId);
      if (!entry) return;
      await this.runtime.deleteFrame(entry.frame);
      current.frames.delete(frameId);
      this.emitFrameCleared(current, entry.frame);
      logger.info(
        `[vision] temporary frame deleted at turn end thread=${threadId} frame=${frameId}`
      );
    });
  }

  private capturePayload(
    current: ActiveThreadVision,
    frame: VisionTemporaryFrame,
    data: Buffer,
    reused: boolean
  ): VisionOnDemandCapture {
    return {
      frameId: frame.id,
      sessionId: frame.sessionId,
      source: frame.source,
      capturedAt: frame.capturedAt,
      mediaType: frame.mimeType,
      byteLength: frame.byteLength,
      base64: data.toString('base64'),
      reused,
      deliveryUrl: this.deliveryUrl(current, frame),
      expiresAt: frame.expiresAt,
    };
  }

  private async clearAllFrames(current: ActiveThreadVision): Promise<void> {
    const entries = [...current.frames.values()];
    await Promise.all(entries.map(({ frame }) => this.runtime.deleteFrame(frame)));
    for (const { frame, turnKey: ownerTurn } of entries) {
      // A source switch must clear current pixels without granting a second
      // capture to an in-flight turn. Keep a tombstone until that turn's
      // teardown releases it.
      current.turnCaptures.set(ownerTurn, null);
      this.emitFrameCleared(current, frame);
    }
    current.frames.clear();
  }

  private emitFrameCleared(current: ActiveThreadVision, frame: VisionTemporaryFrame): void {
    this.emitPreviewClear({
      threadId: current.threadId,
      sessionId: current.session.sessionId,
      frameId: frame.id,
      source: frame.source,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Serialize every lifecycle/capture operation so stop and source switches cannot orphan bytes. */
  private async serialize<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.operations.set(threadId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.operations.get(threadId) === queued) this.operations.delete(threadId);
    }
  }

  private disabledStatus(threadId: string): VisionThreadStatus {
    return {
      enabled: false,
      threadId,
      source: null,
      sessionId: null,
      sessionDir: null,
      temporaryFrameCount: 0,
    };
  }
}

export const visionThreadService = new VisionThreadService();

// Exported for focused tests that need a private spool root without changing
// the production singleton.
export function runtimeForSnapshotService(service: VisionSnapshotService): VisionThreadRuntime {
  return {
    createSession: () => service.createSession(),
    captureFrame: (session, source, options, signal) =>
      service.captureFrame(session, source, options, signal),
    storeFrame: (session, source, data) => service.storeFrame(session, source, data),
    readFrame: (frame) => service.readFrame(frame),
    deleteFrame: (frame) => service.deleteFrame(frame),
    deleteSession: (session) => service.deleteSession(session),
    cleanupAbandonedSessions: () => service.cleanupAbandonedSessions(),
  };
}
