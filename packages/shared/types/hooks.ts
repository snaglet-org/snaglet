export type HookRunSource = 'event' | 'manual' | 'schedule';
export type HookRunStatus = 'running' | 'succeeded' | 'failed' | 'timed_out';

/**
 * Durable execution record for one hook child process.
 *
 * Event payloads are deliberately not retained: the ledger is operational
 * history, not a second copy of workspace content or credentials.
 */
export interface HookRunRecord {
  id: string;
  hookName: string;
  source: HookRunSource;
  eventName: string;
  status: HookRunStatus;
  agentId: string | null;
  threadId: string | null;
  durationMs: number | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  startedAt: string;
  finishedAt: string | null;
}
