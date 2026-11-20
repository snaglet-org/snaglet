import { access, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { VisionCaptureErrorCode } from '@snaglet/shared/types';
import {
  NativeVisionSnapshotRuntime,
  VisionSnapshotService,
  type VisionSnapshotRuntime,
} from '@server/services/vision/VisionSnapshotService';
import {
  VisionCaptureError,
  describeVisionCaptureFailure,
} from '@server/services/vision/visionCaptureErrors';
import {
  VisionThreadService,
  runtimeForSnapshotService,
  type VisionThreadRuntime,
} from '@server/services/vision/VisionThreadService';

const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(96, 9)]);

async function setup() {
  const spoolRoot = await mkdtemp(path.join(os.tmpdir(), 'snaglet-vision-thread-'));
  const captureSources: string[] = [];
  const snapshotRuntime: VisionSnapshotRuntime = {
    async captureFrame(framePath, source) {
      captureSources.push(source);
      await writeFile(framePath, JPEG);
    },
  };
  const snapshots = new VisionSnapshotService(snapshotRuntime, { spoolRoot });
  const runtime: VisionThreadRuntime = {
    ...runtimeForSnapshotService(snapshots),
  };
  const states: Array<{ phase: string; source: string | null; ready: boolean }> = [];
  const previews: Array<{ frameId: string; source: string; deliveryUrl: string }> = [];
  const clears: Array<{ frameId: string; source: string }> = [];
  const browserCaptures: Array<{ clientId: string; threadId: string; source: string }> = [];
  const service = new VisionThreadService(
    runtime,
    (state) => states.push(state),
    (frame) => previews.push(frame),
    (clear) => clears.push(clear),
    async (clientId, threadId, source) => {
      browserCaptures.push({ clientId, threadId, source });
      return JPEG;
    }
  );
  return { service, snapshots, captureSources, browserCaptures, states, previews, clears };
}

describe('VisionThreadService on-demand lifecycle', () => {
  it('starts permission-only with no capture, analysis, manifest, or preview', async () => {
    const harness = await setup();
    const status = await harness.service.start('thread-1', 'screen', 'browser-client-1');

    expect(status).toMatchObject({
      enabled: true,
      source: 'screen',
      temporaryFrameCount: 0,
    });
    expect(harness.captureSources).toEqual([]);
    expect(harness.previews).toEqual([]);
    expect(await readdir(path.join(status.sessionDir!, 'frames'))).toEqual([]);
    await expect(access(path.join(status.sessionDir!, 'frames.jsonl'))).rejects.toThrow();
    expect(harness.service.sessionState('thread-1')).toMatchObject({
      phase: 'active',
      ready: true,
    });
    // Access is permission, not perception: an agent that has not yet run sees
    // the grant as an `enabled` transition, and nothing has been captured.
    expect(harness.service.accessDeltaFor('thread-1', 'agent-1')).toMatchObject({
      transition: { kind: 'enabled', source: 'screen' },
      current: 'screen',
    });
  });

  it.each(['screen', 'camera'] as const)(
    'takes one fresh %s frame, reuses it within the turn, and deletes it at turn end',
    async (source) => {
      const harness = await setup();
      await harness.service.start('thread-1', source, 'browser-client-1');
      const input = {
        ownerUserId: 'user-1',
        threadId: 'thread-1',
        agentId: 'agent-1',
        turnId: 'message-1',
        source,
      };

      const first = await harness.service.captureOnDemand(input);
      const repeated = await harness.service.captureOnDemand(input);

      // Screen and camera both come from the Snaglet window that granted access;
      // the native snapshot runtime is never asked for a frame.
      expect(harness.captureSources).toEqual([]);
      expect(harness.browserCaptures).toEqual([
        { clientId: 'browser-client-1', threadId: 'thread-1', source },
      ]);
      expect(repeated).toMatchObject({ frameId: first.frameId, reused: true, source });
      expect(harness.previews).toEqual([
        expect.objectContaining({
          frameId: first.frameId,
          source,
          deliveryUrl: expect.stringContaining(first.frameId),
        }),
      ]);
      expect(harness.service.status('thread-1').temporaryFrameCount).toBe(1);

      await harness.service.releaseTurnFrames('thread-1', 'agent-1', 'message-1');
      expect(harness.service.status('thread-1').temporaryFrameCount).toBe(0);
      expect(harness.clears).toEqual([expect.objectContaining({ frameId: first.frameId, source })]);
      await expect(
        access(
          path.join(
            harness.service.status('thread-1').sessionDir!,
            'frames',
            `${first.frameId}.jpg`
          )
        )
      ).rejects.toThrow();
    }
  );

  it('captures a camera frame with the production native runtime without any Swift helper', async () => {
    // The original failure: "VisionSnapshotService: apple-camera.swift not
    // found. Set SNAGLET_APPLE_MODELS_DIR to its directory." A camera capture must
    // never reach the native runtime, so it succeeds with the real one and
    // leaves no compile cache behind.
    const spoolRoot = await mkdtemp(path.join(os.tmpdir(), 'snaglet-vision-native-camera-'));
    const snapshots = new VisionSnapshotService(new NativeVisionSnapshotRuntime(), { spoolRoot });
    const previews: unknown[] = [];
    const service = new VisionThreadService(
      runtimeForSnapshotService(snapshots),
      () => undefined,
      (frame) => previews.push(frame),
      () => undefined,
      async () => JPEG
    );
    delete process.env.SNAGLET_APPLE_MODELS_DIR;
    await service.start('thread-1', 'camera', 'browser-client-1');

    const frame = await service.captureOnDemand({
      ownerUserId: 'user-1',
      threadId: 'thread-1',
      agentId: 'agent-1',
      turnId: 'message-1',
      source: 'camera',
    });

    expect(frame).toMatchObject({ source: 'camera', reused: false, mediaType: 'image/jpeg' });
    expect(previews).toHaveLength(1);
    expect((await readdir(spoolRoot)).filter((name) => name.startsWith('.'))).toEqual([]);
    await service.stop('thread-1');
  });

  it('reports each browser-side camera failure with its own code and remediation', async () => {
    const failures: Array<{ code: VisionCaptureErrorCode; detail: string }> = [
      { code: 'permission_denied', detail: 'NotAllowedError' },
      { code: 'device_not_found', detail: 'NotFoundError' },
      { code: 'device_in_use', detail: 'NotReadableError' },
      { code: 'stream_inactive', detail: 'ended' },
    ];
    const messages = new Set<string>();
    for (const failure of failures) {
      const spoolRoot = await mkdtemp(path.join(os.tmpdir(), 'snaglet-vision-camera-failure-'));
      const snapshots = new VisionSnapshotService(new NativeVisionSnapshotRuntime(), { spoolRoot });
      const service = new VisionThreadService(
        runtimeForSnapshotService(snapshots),
        () => undefined,
        () => undefined,
        () => undefined,
        async (_clientId, _threadId, source) => {
          throw new VisionCaptureError(
            failure.code,
            describeVisionCaptureFailure(failure.code, source, failure.detail),
            source
          );
        }
      );
      await service.start('thread-1', 'camera', 'browser-client-1');
      const attempt = service.captureOnDemand({
        ownerUserId: 'user-1',
        threadId: 'thread-1',
        agentId: 'agent-1',
        turnId: 'message-1',
        source: 'camera',
      });
      await expect(attempt).rejects.toMatchObject({ code: failure.code, source: 'camera' });
      const message = await attempt.catch((error: Error) => error.message);
      expect(message).toMatch(/camera/i);
      messages.add(message);
      // A failed attempt leaves no frame and does not consume the turn's one frame.
      expect(service.status('thread-1').temporaryFrameCount).toBe(0);
      expect(await readdir(path.join(service.status('thread-1').sessionDir!, 'frames'))).toEqual(
        []
      );
    }
    expect(messages.size).toBe(failures.length);
  });

  it('allows only one frame total in Both mode, even across screen and camera tools', async () => {
    const harness = await setup();
    await harness.service.start('thread-1', 'both', 'browser-client-1');
    const common = {
      ownerUserId: 'user-1',
      threadId: 'thread-1',
      agentId: 'agent-1',
      turnId: 'message-1',
    };

    const screen = await harness.service.captureOnDemand({ ...common, source: 'screen' });
    const cameraAttempt = await harness.service.captureOnDemand({ ...common, source: 'camera' });

    expect(harness.captureSources).toEqual([]);
    expect(harness.browserCaptures).toHaveLength(1);
    expect(cameraAttempt).toMatchObject({
      frameId: screen.frameId,
      source: 'screen',
      reused: true,
    });
  });

  it('switches access source in the same session without an inactive gap and clears temp pixels', async () => {
    const harness = await setup();
    const first = await harness.service.start('thread-1', 'screen', 'browser-client-1');
    const captured = await harness.service.captureOnDemand({
      ownerUserId: 'user-1',
      threadId: 'thread-1',
      agentId: 'agent-1',
      turnId: 'message-1',
      source: 'screen',
    });

    const switched = await harness.service.start('thread-1', 'camera');

    expect(switched.sessionId).toBe(first.sessionId);
    expect(switched).toMatchObject({ source: 'camera', temporaryFrameCount: 0 });
    expect(harness.states.map(({ phase }) => phase)).toEqual([
      'starting',
      'active',
      'starting',
      'active',
    ]);
    expect(harness.clears).toContainEqual(
      expect.objectContaining({ frameId: captured.frameId, source: 'screen' })
    );
    await expect(
      harness.service.captureOnDemand({
        ownerUserId: 'user-1',
        threadId: 'thread-1',
        agentId: 'agent-1',
        turnId: 'message-1',
        source: 'camera',
      })
    ).rejects.toThrow(/already used/);
    await harness.service.releaseTurnFrames('thread-1', 'agent-1', 'message-1');
  });

  it('stopping deletes the entire session directory and every unpromoted frame', async () => {
    const harness = await setup();
    const started = await harness.service.start('thread-1', 'screen', 'browser-client-1');
    await harness.service.captureOnDemand({
      ownerUserId: 'user-1',
      threadId: 'thread-1',
      agentId: 'agent-1',
      turnId: 'message-1',
      source: 'screen',
    });

    const stopped = await harness.service.stop('thread-1');

    expect(stopped).toMatchObject({ enabled: false, temporaryFrameCount: 0 });
    await expect(access(started.sessionDir!)).rejects.toThrow();
    expect(harness.states.map(({ phase }) => phase)).toEqual([
      'starting',
      'active',
      'stopping',
      'inactive',
    ]);
  });

  it('expires independent frames after their own 60 second deadlines', async () => {
    const harness = await setup();
    await harness.service.start('thread-1', 'screen', 'browser-client-1');
    const first = await harness.service.captureOnDemand({
      ownerUserId: 'user-1',
      threadId: 'thread-1',
      agentId: 'agent-1',
      turnId: 'turn-1',
      source: 'screen',
    });
    const second = await harness.service.captureOnDemand({
      ownerUserId: 'user-1',
      threadId: 'thread-1',
      agentId: 'agent-2',
      turnId: 'turn-2',
      source: 'screen',
    });
    await harness.service.sweepExpiredFrames(
      Math.max(Date.parse(first.expiresAt), Date.parse(second.expiresAt))
    );
    expect(harness.service.status('thread-1').temporaryFrameCount).toBe(0);
    expect(harness.clears.map(({ frameId }) => frameId).sort()).toEqual(
      [first.frameId, second.frameId].sort()
    );
  });

  it('rejects capture when access is off or the requested source was not granted', async () => {
    const harness = await setup();
    const input = {
      ownerUserId: 'user-1',
      threadId: 'thread-1',
      agentId: 'agent-1',
      turnId: 'message-1',
      source: 'camera' as const,
    };
    await expect(harness.service.captureOnDemand(input)).rejects.toThrow(/access is off/);
    await harness.service.start('thread-1', 'screen', 'browser-client-1');
    await expect(harness.service.captureOnDemand(input)).rejects.toThrow(/not enabled/);
  });
});
