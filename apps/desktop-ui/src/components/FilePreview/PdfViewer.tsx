/**
 * In-app PDF viewer: renders a PDF visually (as it looks) to <canvas> pages in a
 * scrollable, fit-to-width column. Used by the file preview surfaces for `.pdf`,
 * which the text routes report as not-previewable.
 *
 * Canvas and a bundled worker rather than <iframe>/<embed>/<object>, because
 * the desktop CSP sets `object-src 'none'` and `script-src 'self'` without
 * unsafe-eval. The worker is a same-origin asset (Vite `?url` import), and
 * `isEvalSupported: false` keeps parsing away from eval.
 *
 * Bytes come from the authenticated raw route through the wrapped fetch(), as
 * in useAuthenticatedImage; the document is destroyed on unmount.
 */

import { useEffect, useRef, useState, type FC } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
// Bundled, same-origin worker URL (Vite emits the asset into the app bundle) —
// see the CSP note above. `?url` yields the hashed asset path, not eval'd code.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { getErrorMessage } from '@snaglet/shared/utils';
import { rawFileUrl, type RawFileSource } from './rawFileSource';
import styles from './FilePreview.module.scss';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Hard cap on pages rendered eagerly. Real documents are well under this; the
 * cap only bounds work on pathological page counts. */
const MAX_RENDER_PAGES = 100;
/** Fallback render width before the container has been laid out. */
const FALLBACK_WIDTH = 800;

type Status = 'loading' | 'ready' | 'error';

export const PdfViewer: FC<{ source: RawFileSource }> = ({ source }) => {
  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [pageCount, setPageCount] = useState(0);
  const [truncated, setTruncated] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);

  const url = rawFileUrl(source);

  // Fetch bytes + parse the document. Re-runs only when the source URL changes.
  useEffect(() => {
    let canceled = false;
    const controller = new AbortController();
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;

    setStatus('loading');
    setErrorMessage('');
    setPageCount(0);
    setTruncated(false);

    (async () => {
      try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal });
        if (!res.ok) {
          throw new Error(`Failed to load PDF: ${res.status} ${res.statusText}`);
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (canceled) return;

        loadingTask = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false });
        const pdf = await loadingTask.promise;
        if (canceled) {
          void pdf.destroy();
          return;
        }

        pdfRef.current = pdf;
        const shown = Math.min(pdf.numPages, MAX_RENDER_PAGES);
        canvasRefs.current = new Array(shown).fill(null);
        setTruncated(pdf.numPages > shown);
        setPageCount(shown);
        setStatus('ready');
      } catch (err) {
        // Aborted runs are silent cleanup — the newer run (or unmount) owns state.
        if (canceled || (err instanceof Error && err.name === 'AbortError')) return;
        setErrorMessage(getErrorMessage(err, 'Failed to load PDF'));
        setStatus('error');
      }
    })();

    return () => {
      canceled = true;
      controller.abort();
      if (loadingTask) void loadingTask.destroy();
      if (pdfRef.current) {
        void pdfRef.current.destroy();
        pdfRef.current = null;
      }
    };
  }, [url]);

  // Render each page to its canvas once the doc is ready and the canvases mount.
  // A per-run cancel flag stops an in-flight render loop if the doc is replaced.
  useEffect(() => {
    if (status !== 'ready' || !pdfRef.current || pageCount === 0) return;
    const pdf = pdfRef.current;
    let canceled = false;

    (async () => {
      const measured = containerRef.current?.clientWidth ?? 0;
      const targetWidth = measured > 0 ? measured : FALLBACK_WIDTH;
      const dpr = window.devicePixelRatio || 1;

      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        if (canceled) return;
        try {
          const page = await pdf.getPage(pageNumber);
          if (canceled) return;
          const canvas = canvasRefs.current[pageNumber - 1];
          const ctx = canvas?.getContext('2d');
          if (!canvas || !ctx) continue;

          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: targetWidth / base.width });
          // Backing store scaled by dpr for crisp text; CSS size stays in CSS px.
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          ctx.scale(dpr, dpr);

          // Paint white paper under the page: a PDF renders its own (usually
          // white) background, but transparent regions would otherwise show the
          // themed app surface behind them. White here is document content, not
          // app chrome, so it is deliberately not a theme token.
          await page.render({ canvasContext: ctx, viewport, background: 'white' }).promise;
        } catch (err) {
          // A single page failing to render must not blank the whole document;
          // leave that canvas empty and keep going.
          console.warn(`PDF page ${pageNumber} failed to render:`, getErrorMessage(err));
        }
      }
    })();

    return () => {
      canceled = true;
    };
  }, [status, pageCount]);

  return (
    <div ref={containerRef} className={styles.pdfViewer}>
      {status === 'loading' && (
        <div className={styles.notice} role="status">
          Loading PDF…
        </div>
      )}
      {status === 'error' && (
        <div className={styles.notice} role="alert">
          Could not load PDF: {errorMessage}
        </div>
      )}
      {status === 'ready' && (
        <>
          {truncated && (
            <div className={styles.notice}>
              This PDF is large — showing the first {pageCount} pages.
            </div>
          )}
          {Array.from({ length: pageCount }, (_, index) => (
            <canvas
              key={index}
              ref={(el) => {
                canvasRefs.current[index] = el;
              }}
              className={styles.pdfPage}
              aria-label={`Page ${index + 1}`}
            />
          ))}
        </>
      )}
    </div>
  );
};
