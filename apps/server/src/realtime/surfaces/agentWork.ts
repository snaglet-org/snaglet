/**
 * Agent-work surface — realtime add/remove events for in-flight agent work
 * (thread runs + hook executions). Fed exclusively by ActiveWorkRegistry so
 * the broadcast always mirrors the snapshot the REST endpoint serves.
 */

import type { ActiveWorkItem } from '@snaglet/shared/types/workspace-events';
import { emitWorkspaceEvent } from '../emit';

export function emitAgentWorkStarted(item: ActiveWorkItem): void {
  emitWorkspaceEvent({
    type: 'agent.work_started',
    item,
  });
}

export function emitAgentWorkFinished(id: string): void {
  emitWorkspaceEvent({
    type: 'agent.work_finished',
    id,
  });
}
