/**
 * idleUnload — a small timer-based helper that disposes a lazily-loaded local
 * model resource (ONNX session, tokenizer) after a period of inactivity, and
 * reloads it transparently on the next use. Shared by LocalEmbedderService
 * (~137MB nomic-embed session) and LocalRerankerService (ms-marco session)
 * so both engines release native memory the same way instead of drifting
 * apart — same "shared by the reranker and embedder" precedent as
 * `fetchModelFiles.ts` in this directory.
 *
 * Usage contract for a caller wrapping a lazy singleton:
 *   - call `touch()` at the START of every call that USES the resource (each
 *     use pushes the idle deadline back out — an active server never
 *     unloads mid-traffic);
 *   - have the lazy loader `await awaitInFlightDispose()` before checking or
 *     creating its cached promise, so a load racing an in-flight dispose
 *     WAITS for it to finish instead of reading a half-cleared cache (the
 *     race-safety requirement: a call arriving mid-dispose reloads cleanly
 *     rather than grabbing a session that's about to be released out from
 *     under it).
 */

export class IdleUnloader {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposing: Promise<void> | null = null;

  /**
   * @param idleMs Reads the current idle threshold (ms) — a FUNCTION, not a
   *   fixed value, so an env override takes effect without a process restart
   *   (mirrors the `voiceSession/constants.ts` per-call env-read pattern),
   *   and so fake-timer tests can shrink the threshold per-test.
   * @param onIdle Performs the actual unload (release native handles, null
   *   the cached promises). Runs at most once per idle period — a second
   *   `touch()` before it fires just reschedules, it doesn't stack calls.
   */
  constructor(
    private readonly idleMs: () => number,
    private readonly onIdle: () => Promise<void>
  ) {}

  /** Call at the start of every resource use — (re)schedules the idle timer. */
  touch(): void {
    if (this.timer) clearTimeout(this.timer);
    const ms = this.idleMs();
    this.timer = setTimeout(() => {
      this.disposing = this.onIdle().finally(() => {
        this.disposing = null;
      });
    }, ms);
    // Idle-unload is a memory optimization, never a reason to keep the
    // process alive — unref so a lone pending timer can't block a clean exit.
    this.timer.unref?.();
  }

  /**
   * Await any in-flight unload before a loader (re)creates its resource.
   * Safe to call even when nothing is disposing (resolves immediately).
   */
  async awaitInFlightDispose(): Promise<void> {
    if (this.disposing) await this.disposing;
  }

  /** Test/shutdown hook: cancel the pending timer without disposing anything. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
