/** A subagent request the model can fix: its message is shown to the caller as-is. */
export class SubagentError extends Error {
  override name = 'SubagentError';
}
