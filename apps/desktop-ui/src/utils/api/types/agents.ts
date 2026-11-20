/**
 * Type definitions for agents — memories and per-agent model configuration.
 */

export interface MemoryStats {
  total: number;
}

export interface MemoryRecord {
  id: string;
  /** The agent that owns it; null for a fact about a person (member-owned). */
  agentId: string | null;
  /** The person it is about, for member-owned memories (proposals, kept facts). */
  memberId: string | null;
  key: string;
  content: string;
  sourceThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET /memories/:id` — one memory with the names its preview shows. Each is
 * null when there is nothing to name (no agent, no source thread, an untitled
 * or archived thread); the preview then falls back to a generic label.
 */
export interface MemoryDetailRecord extends MemoryRecord {
  agentName: string | null;
  sourceThreadTitle: string | null;
}
