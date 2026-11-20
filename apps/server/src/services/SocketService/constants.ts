/**
 * Shared constants for SocketService subsystem.
 */

/**
 * Fallback agent-turn wall-clock timeout in ms, used only when the
 * `agent.timeout_seconds` setting cannot be read. 0 = unlimited, matching the
 * setting's default — a hung model call is caught by the stream-idle watchdog.
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 0;

/**
 * How long the dispatch waits for an ABORTED agent turn (per-agent timeout, or
 * a Stop/reaper abort of a parallel wave) to actually unwind before it stops
 * waiting and moves on. Aborts are threaded into streams and tool executors,
 * so a turn normally settles within milliseconds; this bound only matters for
 * a tool that ignores its signal. Past it the turn is abandoned — its own
 * teardown is ownership-checked (see agentTurnTeardown), so it cannot clobber
 * a newer turn's state when it finally settles.
 */
export const AGENT_ABORT_DRAIN_MS = 10_000;
