/**
 * Reminder delivery: every {@link REMINDER_TICK_MS} the scheduler finds the
 * reminders whose `fireAt` passed since its last tick, records each key in
 * the delivery ledger and emits `reminder:due` for the ones it recorded
 * first (so a reminder fires once across ticks, restarts and servers).
 *
 * It never reaches further back than {@link REMINDER_CATCH_UP_MS}: on boot
 * (or after the machine slept) it delivers what fired in the last 10
 * minutes and drops anything older. Twice a day it prunes ledger rows older
 * than 30 days and row settings whose entry is gone.
 *
 * `tick(at)` takes the time, so tests drive it with any clock.
 */
import { Reminders } from '@snaglet/db/tables/reminders';
import type { ReminderDue } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { emitReminderDue } from '@server/realtime/surfaces/reminders';
import { remindersBetween } from './upcomingReminders';

const REMINDER_TICK_MS = 15_000;
/** How far back a tick (or the first one after boot) still delivers. */
const REMINDER_CATCH_UP_MS = 10 * 60_000;
/** Ledger rows older than this are pruned. */
const REMINDER_DELIVERY_RETENTION_MS = 30 * 86_400_000;
const PRUNE_EVERY_MS = 12 * 3_600_000;

class ReminderScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt: number | null = null;
  private lastPruneAt: number | null = null;
  private ticking = false;

  start(): void {
    if (this.timer) return;
    logger.info(`[reminders] scheduler started (every ${REMINDER_TICK_MS / 1000}s)`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), REMINDER_TICK_MS);
    this.timer.unref?.();
  }

  /** Stop ticking and forget the last tick: the next start catches up as a boot does. */
  stop(): void {
    const wasRunning = this.timer !== null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lastTickAt = null;
    this.lastPruneAt = null;
    if (wasRunning) logger.info('[reminders] scheduler stopped');
  }

  /**
   * Deliver every reminder that fired since the last tick (at most
   * {@link REMINDER_CATCH_UP_MS} back) and was not delivered yet, as of
   * `at`. Returns the ones this tick delivered; an overlapping call delivers
   * nothing.
   */
  async tick(at: Date = new Date()): Promise<ReminderDue[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const now = at.getTime();
      const floor = now - REMINDER_CATCH_UP_MS;
      // A clock set back starts over from the catch-up floor.
      const since =
        this.lastTickAt === null || this.lastTickAt > now
          ? floor
          : Math.max(floor, this.lastTickAt);
      const delivered: ReminderDue[] = [];
      try {
        const due = await remindersBetween({ from: new Date(since), to: new Date(now) });
        for (const reminder of due) {
          if (!(await Reminders.recordDelivery(reminder.key, new Date(now)))) continue;
          emitReminderDue(reminder);
          delivered.push(reminder);
        }
        this.lastTickAt = now;
      } catch (error) {
        // The next tick covers this window again (within the catch-up limit).
        logger.warn(`[reminders] tick failed: ${getErrorMessage(error)}`);
      }
      await this.prune(now);
      return delivered;
    } finally {
      this.ticking = false;
    }
  }

  private async prune(now: number): Promise<void> {
    if (this.lastPruneAt !== null && now - this.lastPruneAt < PRUNE_EVERY_MS) return;
    this.lastPruneAt = now;
    try {
      const deliveries = await Reminders.pruneDeliveries(
        new Date(now - REMINDER_DELIVERY_RETENTION_MS)
      );
      const orphans = await Reminders.pruneOrphanEntries();
      if (deliveries || orphans)
        logger.info(
          `[reminders] pruned ${deliveries} delivery record(s), ${orphans} orphaned row setting(s)`
        );
    } catch (error) {
      logger.warn(`[reminders] prune failed: ${getErrorMessage(error)}`);
    }
  }
}

export const reminderScheduler = new ReminderScheduler();
