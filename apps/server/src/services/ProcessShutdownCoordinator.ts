export type ShutdownDisposition = 'exit' | 'restart';

export interface ProcessShutdownCoordinatorOptions {
  cleanup: (signal: string, disposition: ShutdownDisposition) => Promise<void>;
  exit: (code: number) => void;
  restart: () => void;
  onDuplicate: (signal: string) => void;
  onError: (signal: string, error: unknown) => void;
}

/**
 * Serializes process shutdown requests and only hands control back to the
 * supervisor after async cleanup has completed. This matters for managed
 * PostgreSQL: a supervisor restart must not race the outgoing process while it
 * drains work, closes its pool, and hands off or stops the owned cluster.
 */
export class ProcessShutdownCoordinator {
  private pending: Promise<void> | null = null;

  constructor(private readonly options: ProcessShutdownCoordinatorOptions) {}

  request(signal: string, disposition: ShutdownDisposition, exitCode = 0): Promise<void> {
    if (this.pending) {
      this.options.onDuplicate(signal);
      return this.pending;
    }

    this.pending = this.run(signal, disposition, exitCode);
    return this.pending;
  }

  private async run(
    signal: string,
    disposition: ShutdownDisposition,
    exitCode: number
  ): Promise<void> {
    try {
      await this.options.cleanup(signal, disposition);
    } catch (error: unknown) {
      // Do not ask the supervisor to restart after incomplete cleanup. Exiting
      // as a crash makes nodemon wait for the next change instead of racing a
      // potentially still-open managed database runtime.
      this.options.onError(signal, error);
      this.options.exit(1);
      return;
    }

    if (disposition === 'restart') {
      this.options.restart();
      return;
    }
    this.options.exit(exitCode);
  }
}
