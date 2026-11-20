import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { sniffImageMime } from '@server/services/ToolService/lib/sniffImageMime';
import { VisionCaptureError, describeVisionCaptureFailure } from './visionCaptureErrors';

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_WIDTH = 1_280;
const VISION_FRAME_TTL_MS = 60_000;

export type VisionFrameSource = 'screen' | 'camera';
export type VisionCaptureSource = VisionFrameSource | 'both';

export interface VisionScreenCaptureOptions {
  display?: number;
  windowId?: number;
  region?: string;
}

export interface VisionSnapshotSession {
  sessionId: string;
  sessionDir: string;
  framesDir: string;
  spoolRoot: string;
  startedAt: string;
}

export interface VisionTemporaryFrame {
  id: string;
  sessionId: string;
  source: VisionFrameSource;
  capturedAt: string;
  path: string;
  mimeType: 'image/jpeg' | 'image/png';
  byteLength: number;
  expiresAt: string;
}

export interface VisionSnapshotRuntime {
  captureFrame(
    framePath: string,
    source: VisionFrameSource,
    options: VisionScreenCaptureOptions,
    maxWidth: number,
    spoolRoot: string,
    signal?: AbortSignal
  ): Promise<void>;
}

export interface VisionSnapshotServiceOptions {
  spoolRoot?: string;
  maxFrameWidth?: number;
}

function generatedSessionId(date: Date): string {
  const timestamp = date
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  return `${timestamp}-${randomBytes(4).toString('hex')}`;
}

function validatedSessionId(sessionId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId)) {
    throw new Error('VisionSnapshotService: invalid session id.');
  }
  return sessionId;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`VisionSnapshotService: ${name} must be a positive integer.`);
  }
  return resolved;
}

function assertDirectChild(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (
    path.dirname(resolvedTarget) !== resolvedRoot ||
    path.basename(resolvedTarget).startsWith('.') ||
    resolvedTarget === resolvedRoot
  ) {
    throw new Error(`VisionSnapshotService: refusing unsafe session cleanup target ${target}.`);
  }
}

/**
 * Host-side capture. Only the macOS `screencapture` screen path remains: camera
 * frames always come from the Snaglet window through `storeFrame` (see
 * VisionThreadService), so no native camera helper is compiled, resolved, or
 * required on any platform.
 */
export class NativeVisionSnapshotRuntime implements VisionSnapshotRuntime {
  async captureFrame(
    framePath: string,
    source: VisionFrameSource,
    options: VisionScreenCaptureOptions,
    maxWidth: number,
    _spoolRoot: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (source === 'camera') {
      throw new VisionCaptureError(
        'native_capture_unsupported',
        describeVisionCaptureFailure('native_capture_unsupported', 'camera'),
        'camera'
      );
    }
    if (process.platform !== 'darwin') {
      throw new VisionCaptureError(
        'native_capture_unsupported',
        describeVisionCaptureFailure('native_capture_unsupported', 'screen'),
        'screen'
      );
    }
    {
      const args = ['-x', '-t', 'jpg'];
      if (options.display !== undefined) args.push('-D', String(options.display));
      if (options.windowId !== undefined) args.push('-l', String(options.windowId));
      if (options.region !== undefined) args.push('-R', options.region);
      args.push(framePath);
      await execFileAsync('/usr/sbin/screencapture', args, {
        timeout: COMMAND_TIMEOUT_MS,
        signal,
      });
    }
    await execFileAsync('/usr/bin/sips', ['-Z', String(maxWidth), framePath], {
      timeout: COMMAND_TIMEOUT_MS,
      signal,
    });
  }
}

/**
 * Stateless native capture primitive. It creates no timers, manifests, frame
 * queues, OCR/classifier work, embeddings, or promotion decisions.
 */
export class VisionSnapshotService {
  private readonly runtime: VisionSnapshotRuntime;
  private readonly spoolRoot: string;
  private readonly maxFrameWidth: number;

  constructor(
    runtime: VisionSnapshotRuntime = new NativeVisionSnapshotRuntime(),
    options: VisionSnapshotServiceOptions = {},
    private readonly now: () => Date = () => new Date()
  ) {
    this.runtime = runtime;
    this.spoolRoot = path.resolve(
      options.spoolRoot ?? path.join(os.homedir(), '.snaglet', 'vision')
    );
    this.maxFrameWidth = positiveInteger(
      options.maxFrameWidth,
      DEFAULT_MAX_FRAME_WIDTH,
      'maxFrameWidth'
    );
  }

  async createSession(sessionId = generatedSessionId(this.now())): Promise<VisionSnapshotSession> {
    const safeId = validatedSessionId(sessionId);
    const sessionDir = path.join(this.spoolRoot, safeId);
    const framesDir = path.join(sessionDir, 'frames');
    await mkdir(framesDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'session.json'),
      JSON.stringify({ pid: process.pid, startedAt: this.now().toISOString() })
    );
    return {
      sessionId: safeId,
      sessionDir,
      framesDir,
      spoolRoot: this.spoolRoot,
      startedAt: this.now().toISOString(),
    };
  }

  async captureFrame(
    session: VisionSnapshotSession,
    source: VisionFrameSource,
    options: VisionScreenCaptureOptions = {},
    signal?: AbortSignal
  ): Promise<{ frame: VisionTemporaryFrame; data: Buffer }> {
    const id = `frame-${randomBytes(24).toString('base64url')}`;
    const capturedAt = this.now().toISOString();
    const framePath = path.join(session.framesDir, `${id}.jpg`);
    try {
      await this.runtime.captureFrame(
        framePath,
        source,
        options,
        this.maxFrameWidth,
        session.spoolRoot,
        signal
      );
      const data = await readFile(framePath);
      const mimeType = sniffImageMime(data);
      if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') {
        throw new Error(`VisionSnapshotService: capture returned unsupported type ${mimeType}.`);
      }
      return {
        frame: {
          id,
          sessionId: session.sessionId,
          source,
          capturedAt,
          path: framePath,
          mimeType,
          byteLength: data.byteLength,
          expiresAt: new Date(this.now().getTime() + VISION_FRAME_TTL_MS).toISOString(),
        },
        data,
      };
    } catch (error) {
      try {
        await unlink(framePath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn(
            `[vision] failed to remove incomplete frame ${path.basename(framePath)}: ${getErrorMessage(cleanupError)}`
          );
        }
      }
      throw error;
    }
  }

  async storeFrame(
    session: VisionSnapshotSession,
    source: VisionFrameSource,
    data: Buffer
  ): Promise<{ frame: VisionTemporaryFrame; data: Buffer }> {
    const id = `frame-${randomBytes(24).toString('base64url')}`;
    const capturedAt = this.now().toISOString();
    const mimeType = sniffImageMime(data);
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') {
      throw new Error(
        `VisionSnapshotService: browser capture returned unsupported type ${mimeType}.`
      );
    }
    const extension = mimeType === 'image/png' ? 'png' : 'jpg';
    const framePath = path.join(session.framesDir, `${id}.${extension}`);
    await writeFile(framePath, data);
    return {
      frame: {
        id,
        sessionId: session.sessionId,
        source,
        capturedAt,
        path: framePath,
        mimeType,
        byteLength: data.byteLength,
        expiresAt: new Date(this.now().getTime() + VISION_FRAME_TTL_MS).toISOString(),
      },
      data,
    };
  }

  async readFrame(frame: VisionTemporaryFrame): Promise<Buffer> {
    return readFile(frame.path);
  }

  async deleteFrame(frame: VisionTemporaryFrame): Promise<void> {
    await unlink(frame.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async deleteSession(session: VisionSnapshotSession): Promise<void> {
    assertDirectChild(session.spoolRoot, session.sessionDir);
    await rm(session.sessionDir, { recursive: true, force: true });
  }

  /** Remove unowned session directories left by a prior crash; keep dot-directories. */
  async cleanupAbandonedSessions(): Promise<string[]> {
    await mkdir(this.spoolRoot, { recursive: true });
    const removed: string[] = [];
    for (const entry of await readdir(this.spoolRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const sessionDir = path.join(this.spoolRoot, entry.name);
      assertDirectChild(this.spoolRoot, sessionDir);
      try {
        const owner = safeJsonParse<{ pid?: unknown }>(
          await readFile(path.join(sessionDir, 'session.json'), 'utf8'),
          {}
        );
        if (typeof owner.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') continue;
          }
        }
      } catch {
        // A session without owner metadata (older format) is necessarily stale.
      }
      await rm(sessionDir, { recursive: true, force: true });
      removed.push(sessionDir);
    }
    return removed;
  }

  async sessionExists(session: VisionSnapshotSession): Promise<boolean> {
    try {
      return (await stat(session.sessionDir)).isDirectory();
    } catch {
      return false;
    }
  }
}

export const visionSnapshotService = new VisionSnapshotService();
