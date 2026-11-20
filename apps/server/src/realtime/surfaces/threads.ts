import type {
  ThreadPatch,
  ThreadSnapshot,
  ThreadStatus,
} from '@snaglet/shared/types/workspace-events';
import type {
  SocketChatMessageUpdatedMsg,
  VisionPreviewClearPayload,
  VisionPreviewFramePayload,
  VisionSessionStatePayload,
} from '@snaglet/shared/types';
import { wsService } from '@server/services/WebSocketService';
import { emitWorkspaceEvent } from '../emit';

interface ThreadRowLike {
  id: string;
  title: string | null;
  /** Project scope, or null for a flat (workspace-level) thread. */
  projectId: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export function snapshotFromThreadNode(
  thread: ThreadRowLike,
  status: ThreadStatus = 'active'
): ThreadSnapshot {
  return {
    id: thread.id,
    title: thread.title ?? '',
    status,
    projectId: thread.projectId,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt ?? thread.createdAt,
  };
}

export function emitThreadCreated(thread: ThreadSnapshot): void {
  emitWorkspaceEvent({
    type: 'thread.created',
    thread,
  });
}

export function emitThreadUpdated(patch: ThreadPatch): void {
  emitWorkspaceEvent({
    type: 'thread.updated',
    patch,
  });
}

export function emitThreadDeleted(id: string): void {
  emitWorkspaceEvent({
    type: 'thread.deleted',
    id,
  });
}

export function emitThreadRunStarted(threadId: string): void {
  emitWorkspaceEvent({
    type: 'thread.run_started',
    threadId,
  });
}

export function emitThreadRunFinished(threadId: string): void {
  emitWorkspaceEvent({
    type: 'thread.run_finished',
    threadId,
  });
}

/**
 * A persisted message's content was edited. Call only after the update has
 * succeeded. Goes to the thread's room alone, the editing client included.
 * The payload is built field by field so a wider row passed in never leaks
 * more than these four fields onto the wire.
 */
export function emitThreadMessageUpdated(update: SocketChatMessageUpdatedMsg['payload']): void {
  const message: SocketChatMessageUpdatedMsg = {
    type: 'socket:chat:message_updated',
    payload: {
      threadId: update.threadId,
      id: update.id,
      content: update.content,
      updatedAt: update.updatedAt,
    },
  };
  wsService.broadcastToChannel(update.threadId, message);
}

/** Thread-scoped vision state. Both tool and composer entry points use this surface. */
export function emitThreadVisionState(state: VisionSessionStatePayload): void {
  wsService.broadcastToChannel(state.threadId, {
    type: 'vision:session:state',
    payload: state,
  });
}

/** Ephemeral, thread-scoped ground-truth preview; never persisted as a message. */
export function emitThreadVisionPreview(frame: VisionPreviewFramePayload): void {
  wsService.broadcastToChannel(frame.threadId, {
    type: 'vision:preview:frame',
    payload: frame,
  });
}

/** Remove turn-scoped pixels from the preview as soon as their temp frame is gone. */
export function emitThreadVisionPreviewClear(payload: VisionPreviewClearPayload): void {
  wsService.broadcastToChannel(payload.threadId, {
    type: 'vision:preview:clear',
    payload,
  });
}
