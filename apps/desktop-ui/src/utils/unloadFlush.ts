/**
 * Last-chance saves when the page goes away: a reload (Cmd+R), a window
 * close, or a navigation.
 *
 * Autosave hooks debounce their writes, so an unload inside that window
 * would drop the last edit. Each hook registers a flush here. On
 * `beforeunload` (and `pagehide`, for unloads that skip it) every flush
 * runs once and starts its request right away; timers never fire again
 * once unloading starts. While the flushes run, `fetchJson` marks the
 * requests they start `keepalive` (when the body is small enough) so the
 * browser completes them after the page is gone.
 */

/** Starts the pending write, if any. May return its promise. */
type UnloadFlush = () => unknown;

/** Browsers cap in-flight keepalive request bodies at 64 KiB in total. */
const KEEPALIVE_BODY_LIMIT_BYTES = 60 * 1024;

const flushes = new Set<UnloadFlush>();
let listening = false;
/** True while flushes run and in the microtasks right after them. */
let unloading = false;
/** One flush per unload: `pagehide` follows `beforeunload` on a reload. */
let flushed = false;

function runUnloadFlushes(): void {
  if (flushed) return;
  flushed = true;
  unloading = true;
  for (const flush of [...flushes]) {
    try {
      const result = flush();
      if (result instanceof Promise) {
        result.catch((err: unknown) => console.error('[unloadFlush] save failed', err));
      }
    } catch (err) {
      console.error('[unloadFlush] save failed', err);
    }
  }
  // Flushed requests start synchronously or in the microtasks right after.
  // If the page stays (a canceled unload), this timer still runs and later
  // requests go back to normal; a page restored from the back/forward cache
  // resets on `pageshow`.
  setTimeout(resetUnload, 0);
}

function resetUnload(): void {
  unloading = false;
  flushed = false;
}

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('beforeunload', runUnloadFlushes);
  window.addEventListener('pagehide', runUnloadFlushes);
  window.addEventListener('pageshow', resetUnload);
}

/** Run `flush` when the page unloads; returns the unregister function. */
export function registerUnloadFlush(flush: UnloadFlush): () => void {
  listen();
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

function bodyFitsKeepalive(body: RequestInit['body']): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body === 'string') return new Blob([body]).size <= KEEPALIVE_BODY_LIMIT_BYTES;
  if (body instanceof Blob) return body.size <= KEEPALIVE_BODY_LIMIT_BYTES;
  return false;
}

/**
 * `init` with `keepalive: true` when the page is unloading and the body is
 * small enough to be kept alive; otherwise `init` unchanged (same object).
 */
export function withUnloadKeepalive(init: RequestInit): RequestInit {
  if (!unloading || init.keepalive || !bodyFitsKeepalive(init.body)) return init;
  return { ...init, keepalive: true };
}
