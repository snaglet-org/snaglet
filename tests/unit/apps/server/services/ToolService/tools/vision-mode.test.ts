const startMock = jest.fn();
const stopMock = jest.fn();
const statusMock = jest.fn();

jest.mock('@server/services/vision/VisionThreadService', () => ({
  visionThreadService: {
    start: (...args: unknown[]) => startMock(...args),
    stop: (...args: unknown[]) => stopMock(...args),
    status: (...args: unknown[]) => statusMock(...args),
  },
}));

// Toggling vision through the TOOL narrates the same persisted thread_event the
// socket handler does — an agent that grants itself access is still a thread
// state change every other participant needs to learn about.
const emitVisionModeChangedMock = jest.fn();
jest.mock('@server/services/SocketService/threadEvents', () => ({
  emitVisionModeChangedEvent: (...args: unknown[]) => emitVisionModeChangedMock(...args),
}));

import tool from '@server/services/ToolService/tools/media/vision-mode/tool';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import type { VisionCaptureSource } from '@server/services/vision/VisionSnapshotService';

function status(source: VisionCaptureSource = 'screen', enabled = true) {
  return {
    enabled,
    threadId: 'thread-1',
    source: enabled ? source : null,
    sessionId: enabled ? 'vision-session' : null,
    sessionDir: enabled ? '/tmp/vision/vision-session' : null,
    temporaryFrameCount: 0,
  };
}

const context: ToolHandlerContext = { threadId: 'thread-1', agentId: 'agent-1' };

beforeEach(() => {
  jest.clearAllMocks();
  let current = status();
  statusMock.mockImplementation(() => current);
  startMock.mockImplementation(async (_threadId: string, source: VisionCaptureSource) => {
    current = status(source);
    return current;
  });
  stopMock.mockImplementation(async () => {
    current = status('screen', false);
    return current;
  });
});

describe('vision_mode access tool', () => {
  it.each(['screen', 'camera', 'both'] as const)(
    'starts permission-only %s access without capturing a frame',
    async (source) => {
      const result = await tool({ action: 'start', source }, {}, context);
      if (typeof result !== 'string') throw new Error('expected text result');
      const payload = JSON.parse(result);

      expect(startMock).toHaveBeenCalledWith('thread-1', source);
      expect(payload).toMatchObject({
        success: true,
        action: 'start',
        vision: {
          enabled: true,
          source,
          temporary_frame_count: 0,
          capture_policy: 'fresh_on_demand_only',
        },
      });
      expect(payload.note).toMatch(/No frame was captured/);
    }
  );

  it('reports access status without daemon counters or a manifest path', async () => {
    const result = await tool({ action: 'status' }, {}, context);
    if (typeof result !== 'string') throw new Error('expected text result');
    const payload = JSON.parse(result);

    expect(payload.vision).toMatchObject({
      enabled: true,
      temporary_frame_count: 0,
      capture_policy: 'fresh_on_demand_only',
    });
    expect(JSON.stringify(payload)).not.toContain('manifest');
    expect(JSON.stringify(payload)).not.toContain('effective_fps');
  });

  it('stops only this thread access session', async () => {
    const result = await tool({ action: 'stop' }, {}, context);
    if (typeof result !== 'string') throw new Error('expected text result');
    expect(stopMock).toHaveBeenCalledWith('thread-1');
    expect(JSON.parse(result)).toMatchObject({ vision: { enabled: false } });
  });

  it('requires chat context and validates controls', async () => {
    await expect(tool({ action: 'start' }, {}, undefined)).rejects.toThrow(/chat thread/);
    await expect(tool({ action: 'pause' }, {}, context)).rejects.toThrow(/action/);
    await expect(tool({ action: 'start', source: 'microphone' }, {}, context)).rejects.toThrow(
      /source/
    );
  });

  it('narrates a source switch made through the tool, with before and after', async () => {
    // beforeEach seeds the thread as already granted 'screen'.
    await tool({ action: 'start', source: 'camera' }, {}, context);
    expect(emitVisionModeChangedMock).toHaveBeenCalledWith('thread-1', 'screen', 'camera');
  });

  it('narrates a revocation made through the tool', async () => {
    await tool({ action: 'stop' }, {}, context);
    expect(emitVisionModeChangedMock).toHaveBeenCalledWith('thread-1', 'screen', null);
  });

  it('never narrates a read-only status call', async () => {
    await tool({ action: 'status' }, {}, context);
    expect(emitVisionModeChangedMock).not.toHaveBeenCalled();
  });
});
