import type { ToolHandler } from '@server/services/ToolService/types';
import type { VisionCaptureSource } from '@server/services/vision/VisionSnapshotService';
import {
  visionThreadService,
  type VisionThreadStatus,
} from '@server/services/vision/VisionThreadService';
import { emitVisionModeChangedEvent } from '@server/services/SocketService/threadEvents';

type VisionAction = 'start' | 'stop' | 'status';

const SOURCES = new Set<VisionCaptureSource>(['screen', 'camera', 'both']);
const ACTIONS = new Set<VisionAction>(['start', 'stop', 'status']);

function readAction(value: unknown): VisionAction {
  if (typeof value !== 'string' || !ACTIONS.has(value as VisionAction)) {
    throw new Error('vision_mode: `action` must be start, stop, or status.');
  }
  return value as VisionAction;
}

function readSource(value: unknown): VisionCaptureSource {
  const source = value === undefined ? 'screen' : value;
  if (typeof source !== 'string' || !SOURCES.has(source as VisionCaptureSource)) {
    throw new Error('vision_mode: `source` must be screen, camera, or both.');
  }
  return source as VisionCaptureSource;
}

function statusPayload(status: VisionThreadStatus): Record<string, unknown> {
  return {
    enabled: status.enabled,
    thread_id: status.threadId,
    source: status.source,
    session_id: status.sessionId,
    session_dir: status.sessionDir,
    temporary_frame_count: status.temporaryFrameCount,
    capture_policy: 'fresh_on_demand_only',
  };
}

const tool: ToolHandler = async (input, _settings, context) => {
  const threadId = context?.threadId;
  if (!threadId) throw new Error('vision_mode: this control must be used from a chat thread.');

  const action = readAction(input.action);
  if (action === 'status') {
    return JSON.stringify({
      success: true,
      action,
      vision: statusPayload(visionThreadService.status(threadId)),
    });
  }
  // Narration is driven from the toggle CALL SITES (here and the vision socket
  // handlers) rather than from inside VisionThreadService, so the service keeps
  // no database dependency and a server shutdown (stopAll) cannot narrate a
  // revocation nobody performed. The emitter no-ops when nothing changed.
  const before = visionThreadService.status(threadId).source;
  if (action === 'stop') {
    const stopped = await visionThreadService.stop(threadId);
    void emitVisionModeChangedEvent(threadId, before, stopped.source);
    return JSON.stringify({ success: true, action, vision: statusPayload(stopped) });
  }

  const source = readSource(input.source);
  const started = await visionThreadService.start(threadId, source);
  void emitVisionModeChangedEvent(threadId, before, started.source);
  return JSON.stringify({
    success: true,
    action,
    vision: statusPayload(started),
    note: 'Vision access is active. No frame was captured. Use the matching capture tool only when fresh visual context is needed.',
  });
};

export default tool;
