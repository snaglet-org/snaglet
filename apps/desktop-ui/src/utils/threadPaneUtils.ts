import type { ToolAccessConfig } from '@snaglet/shared/types';

export function isToolAccessEqual(left: ToolAccessConfig, right: ToolAccessConfig): boolean {
  if (left.mode !== right.mode) return false;
  if (left.allowList.length !== right.allowList.length) return false;
  if (left.denyList.length !== right.denyList.length) return false;

  for (let i = 0; i < left.allowList.length; i += 1) {
    if (left.allowList[i] !== right.allowList[i]) return false;
  }
  for (let i = 0; i < left.denyList.length; i += 1) {
    if (left.denyList[i] !== right.denyList[i]) return false;
  }

  return true;
}

// Per-agent budget reads return only agent-scope fields (per-call/per-turn limits).
// Conversation-level caps (maxWaves, maxAgentDispatches) live on the thread itself.
// Conversation-wide budget caps stored at threads.config_json.budget.
// config_json.history takes no part in compression — the tail derives from the
// token budget server-side — so a stale stanza in a stored config is ignored.
