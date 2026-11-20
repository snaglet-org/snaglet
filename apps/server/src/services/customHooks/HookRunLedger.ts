import { HookRuns } from '@snaglet/db';
import type { HookRunRecord, HookRunSource } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { emitHookRunFinished, emitHookRunStarted } from '@server/realtime/surfaces/hookRuns';
import type { HookRunResult, HookRunRecorder } from './hookRunner';

class HookRunLedger implements HookRunRecorder {
  async start(input: {
    id: string;
    hookName: string;
    source: HookRunSource;
    eventName: string;
    agentId?: string;
    threadId?: string;
    chainDepth?: number;
  }): Promise<void> {
    try {
      const run = await HookRuns.start(input);
      emitHookRunStarted(run);
    } catch (err) {
      logger.warn(`[hooks] could not record run start: ${getErrorMessage(err)}`);
    }
  }

  async finish(id: string, result: HookRunResult): Promise<void> {
    try {
      const status = result.timedOut ? 'timed_out' : result.ok ? 'succeeded' : 'failed';
      const run = await HookRuns.finish(id, {
        status,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      if (run) emitHookRunFinished(run);
    } catch (err) {
      logger.warn(`[hooks] could not record run finish: ${getErrorMessage(err)}`);
    }
  }

  async listRecent(limit?: number): Promise<HookRunRecord[]> {
    return HookRuns.listRecent(limit);
  }

  async listByHook(hookName: string, limit?: number): Promise<HookRunRecord[]> {
    return HookRuns.listByHook(hookName, limit);
  }

  async markInterrupted(): Promise<void> {
    try {
      const count = await HookRuns.markInterrupted();
      if (count > 0) logger.warn(`[hooks] marked ${count} interrupted run(s) as failed`);
    } catch (err) {
      logger.warn(`[hooks] interrupted-run cleanup failed: ${getErrorMessage(err)}`);
    }
  }
}

export const hookRunLedger = new HookRunLedger();
