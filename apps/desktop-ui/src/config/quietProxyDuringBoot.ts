// Dev/preview only. `pnpm dev` starts Vite and the backend together; Vite is up
// first and may briefly proxy requests into an ECONNREFUSED backend. Keep that
// expected race to one notice per proxy while preserving useful diagnostics for
// every other error.
export type ProxyError = NodeJS.ErrnoException & { errors?: NodeJS.ErrnoException[] };

export const isConnectionRefused = (err: ProxyError | undefined): boolean => {
  // AggregateError from a dual-stack dial carries the per-address codes in
  // `.errors`; a plain error carries its code directly.
  const codes = [err?.code, ...(err?.errors?.map((error) => error?.code) ?? [])];
  return codes.some((code) => code === 'ECONNREFUSED');
};

// http-proxy hands the error handler an `http.ServerResponse` for `/api` and a
// raw `net.Socket` for `/ws` upgrades — only the former has `writeHead`.
export type ProxyResponse =
  | {
      writeHead: (status: number, headers?: Record<string, string>) => unknown;
      end: (body?: string) => void;
      headersSent?: boolean;
      writableEnded?: boolean;
    }
  | { end: () => void };

export interface ConfigurableProxy {
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  removeAllListeners: (event: string) => void;
}

export const quietProxyDuringBoot =
  (label: string) =>
  (proxy: ConfigurableProxy): void => {
    let bootNoticeLogged = false;
    const markBackendAvailable = () => {
      // A successful HTTP response or WebSocket connection ends the current
      // startup/outage window. If the backend later disappears, report that
      // new outage once instead of hiding it for the rest of the Vite process.
      bootNoticeLogged = false;
    };
    const onError = (err: ProxyError, req?: { url?: string }, res?: ProxyResponse) => {
      if (isConnectionRefused(err)) {
        // Bound startup noise: `/api` and `/ws` each report at most once per
        // Vite process even when clients retry while the DB is migrating.
        if (!bootNoticeLogged) {
          console.log(`[proxy] backend not ready yet — ${label} ${req?.url ?? ''}`.trimEnd());
          bootNoticeLogged = true;
        }
      } else {
        // A genuine proxy failure once the backend is up: keep the stack.
        console.error(
          `[proxy] ${label} error: ${err?.message ?? String(err)}\n${err?.stack ?? ''}`
        );
      }

      if (res && 'writeHead' in res) {
        if (!res.writableEnded) {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('backend starting');
          } else {
            // The proxy may already have started a response before its upstream
            // failed. Its status/body can't be replaced at that point, but it must
            // still be ended so the browser does not wait forever.
            res.end();
          }
        }
      } else if (res) {
        res.end();
      }
    };

    // `proxyRes` is http-proxy's successful HTTP upstream response event;
    // `open` is its successful WebSocket connection event.
    proxy.on('proxyRes', markBackendAvailable);
    proxy.on('open', markBackendAvailable);

    // Vite attaches its own stack-dumping `error` handler immediately after this
    // `configure` call returns (both would fire and the stack would still
    // print). Swap it out on the next microtask so ours is the only one. Coupled
    // to Vite's proxy-middleware ordering; dev-only, revisit on a Vite major bump.
    queueMicrotask(() => {
      proxy.removeAllListeners('error');
      proxy.on('error', onError as (...args: unknown[]) => void);
    });
  };
