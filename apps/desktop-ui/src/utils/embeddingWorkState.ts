import { useSyncExternalStore } from 'react';
import { embeddingsApi } from './api';
import type { EmbeddingMaintenanceStatus } from './api/types';

export interface EmbedWorkItem {
  nodeId: string;
  nodeType: string;
  nodeTitle: string;
  startedAt: string;
}
interface State {
  items: EmbedWorkItem[];
  maintenance: EmbeddingMaintenanceStatus | null;
}
let state: State = { items: [], maintenance: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
export const embeddingWorkState = {
  getSnapshot: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  startEmbed(nodeId: string, nodeType: string, nodeTitle = nodeId) {
    if (state.items.some((item) => item.nodeId === nodeId && item.nodeType === nodeType)) return;
    state = {
      ...state,
      items: [...state.items, { nodeId, nodeType, nodeTitle, startedAt: new Date().toISOString() }],
    };
    emit();
  },
  finishEmbed(nodeId: string, nodeType: string) {
    state = {
      ...state,
      items: state.items.filter((item) => item.nodeId !== nodeId || item.nodeType !== nodeType),
    };
    emit();
  },
  async refreshMaintenance() {
    try {
      const maintenance = await embeddingsApi.getMaintenanceStatus();
      state = { ...state, maintenance };
      emit();
      return maintenance;
    } catch {
      return null;
    }
  },
};
export function useEmbeddingWork() {
  return useSyncExternalStore(
    embeddingWorkState.subscribe,
    embeddingWorkState.getSnapshot,
    embeddingWorkState.getSnapshot
  );
}
