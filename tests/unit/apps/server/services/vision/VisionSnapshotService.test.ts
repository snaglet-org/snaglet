import { access, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  NativeVisionSnapshotRuntime,
  VisionSnapshotService,
  type VisionSnapshotRuntime,
} from '@server/services/vision/VisionSnapshotService';

const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(96, 7)]);

describe('VisionSnapshotService', () => {
  it.each(['screen', 'camera'] as const)(
    'creates an empty access session and captures exactly one %s frame only on demand',
    async (source) => {
      const spoolRoot = await mkdtemp(path.join(os.tmpdir(), `snaglet-vision-${source}-`));
      const captures: string[] = [];
      const runtime: VisionSnapshotRuntime = {
        async captureFrame(framePath, frameSource) {
          captures.push(frameSource);
          await writeFile(framePath, JPEG);
        },
      };
      const service = new VisionSnapshotService(runtime, { spoolRoot });
      const session = await service.createSession('unit-session');

      expect(captures).toEqual([]);
      expect(await readdir(session.framesDir)).toEqual([]);
      await expect(access(path.join(session.sessionDir, 'frames.jsonl'))).rejects.toThrow();

      const captured = await service.captureFrame(session, source);
      expect(captures).toEqual([source]);
      expect(captured.frame).toMatchObject({ source, mimeType: 'image/jpeg' });
      expect(captured.data).toEqual(JPEG);
      expect(await readdir(session.framesDir)).toEqual([`${captured.frame.id}.jpg`]);

      await service.deleteFrame(captured.frame);
      expect(await readdir(session.framesDir)).toEqual([]);
    }
  );

  it('never compiles or resolves a native camera helper: the native runtime refuses camera frames with a distinct code', async () => {
    const spoolRoot = await mkdtemp(path.join(os.tmpdir(), 'snaglet-vision-native-'));
    const service = new VisionSnapshotService(new NativeVisionSnapshotRuntime(), { spoolRoot });
    const session = await service.createSession('native-session');
    delete process.env.SNAGLET_APPLE_MODELS_DIR;

    await expect(service.captureFrame(session, 'camera')).rejects.toMatchObject({
      name: 'VisionCaptureError',
      code: 'native_capture_unsupported',
      source: 'camera',
    });
    await expect(service.captureFrame(session, 'camera')).rejects.toThrow(/Snaglet window/);
    // No compile cache, no partial frame.
    expect(await readdir(spoolRoot)).toEqual(['native-session']);
    expect(await readdir(session.framesDir)).toEqual([]);
  });

  it('deletes abandoned session directories on startup but preserves dot-directories', async () => {
    const spoolRoot = await mkdtemp(path.join(os.tmpdir(), 'snaglet-vision-abandoned-'));
    await mkdir(path.join(spoolRoot, 'old-screen', 'frames'), { recursive: true });
    await mkdir(path.join(spoolRoot, 'old-camera', 'frames'), { recursive: true });
    await mkdir(path.join(spoolRoot, '.runtime'), { recursive: true });
    const runtime: VisionSnapshotRuntime = { captureFrame: jest.fn() };
    const service = new VisionSnapshotService(runtime, { spoolRoot });

    const removed = await service.cleanupAbandonedSessions();

    expect(removed.map((item) => path.basename(item)).sort()).toEqual(['old-camera', 'old-screen']);
    expect(await readdir(spoolRoot)).toEqual(['.runtime']);
  });

  it('does not remove a session owned by another live Snaglet process', async () => {
    const spoolRoot = await mkdtemp(path.join(os.tmpdir(), 'snaglet-vision-live-owner-'));
    const runtime: VisionSnapshotRuntime = { captureFrame: jest.fn() };
    const service = new VisionSnapshotService(runtime, { spoolRoot });
    const live = await service.createSession('live-session');

    await expect(service.cleanupAbandonedSessions()).resolves.toEqual([]);
    await expect(access(live.sessionDir)).resolves.toBeUndefined();
  });
});
