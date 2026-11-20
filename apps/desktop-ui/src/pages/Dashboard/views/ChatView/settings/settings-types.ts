/**
 * Shared local types used by ChatSettings sub-components.
 *
 * Extracted so AgentsSection, AgentDetail, and the parent ChatSettings
 * can all import a single canonical definition without circular deps.
 */
import type { SnagletAgent } from '@snaglet/shared/types';
import type { ThreadParticipant } from '@desktop/utils/api';

export interface AgentEntry {
  participant: ThreadParticipant;
  agent: SnagletAgent | null;
  /** For a subagent helper: the orchestrator's name, when known. */
  orchestratorName?: string | null;
}
