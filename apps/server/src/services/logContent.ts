/**
 * The server log records what ran, not what was said. Message text, replies,
 * thinking, tool inputs and outputs, and model payloads are conversation
 * content: they reach the log only when SNAGLET_LOG_CONTENT=1 (for debugging).
 */
export function logsContent(): boolean {
  return process.env.SNAGLET_LOG_CONTENT === '1';
}
