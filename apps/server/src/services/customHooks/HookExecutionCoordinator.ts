import { ConflictError } from '@snaglet/shared/utils';

/**
 * Process-local concurrency gate for destructive hook lifecycle operations.
 *
 * Invocations call begin() before waiting on HookRunner's semaphore, so the
 * count includes both queued and executing work. Clear/delete reserve an idle
 * hook before touching either the filesystem or Postgres; the reservation then
 * blocks every new invocation until commit/rollback and compensation finish.
 */
class HookExecutionCoordinator {
  private readonly invocationCounts = new Map<string, number>();
  private readonly purgeReservations = new Set<string>();

  begin(hookName: string): boolean {
    if (this.purgeReservations.has(hookName)) return false;
    this.invocationCounts.set(hookName, (this.invocationCounts.get(hookName) ?? 0) + 1);
    return true;
  }

  end(hookName: string): void {
    const count = this.invocationCounts.get(hookName) ?? 0;
    if (count <= 1) {
      this.invocationCounts.delete(hookName);
      return;
    }
    this.invocationCounts.set(hookName, count - 1);
  }

  reserve(hookName: string): boolean {
    if (this.purgeReservations.has(hookName)) return false;
    if ((this.invocationCounts.get(hookName) ?? 0) > 0) return false;
    this.purgeReservations.add(hookName);
    return true;
  }

  reserveOrThrow(hookName: string): void {
    if (this.reserve(hookName)) return;
    throw new ConflictError(
      `Hook ${hookName} has a queued or running invocation, or another lifecycle operation is in progress. Wait for it to finish and retry.`
    );
  }

  release(hookName: string): void {
    this.purgeReservations.delete(hookName);
  }

  isReserved(hookName: string): boolean {
    return this.purgeReservations.has(hookName);
  }

  /** Test-only reset. */
  reset(): void {
    this.invocationCounts.clear();
    this.purgeReservations.clear();
  }
}

export const hookExecutionCoordinator = new HookExecutionCoordinator();
