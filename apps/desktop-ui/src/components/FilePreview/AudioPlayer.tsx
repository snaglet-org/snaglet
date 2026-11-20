/**
 * In-app audio player for the file preview surfaces (`.mp3`, `.wav`, `.m4a`,
 * `.ogg`), which the text routes report as not-previewable.
 *
 * A plain `<audio src>` pointing at the raw route cannot carry the desktop
 * session headers, so the bytes are fetched through the global wrapped fetch()
 * and played from a blob URL, mirroring useAuthenticatedImage: StrictMode-safe
 * (per-run cancel flag + AbortController) and the URL is revoked by the run that
 * created it. The desktop CSP allows `media-src blob:` for this.
 */

import { useEffect, useState, type FC } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { rawFileUrl, type RawFileSource } from './rawFileSource';
import styles from './FilePreview.module.scss';

/** The raw routes answer 413 for a file over their size cap. */
const HTTP_PAYLOAD_TOO_LARGE = 413;

type PlayerState =
  | { status: 'loading' }
  | { status: 'ready'; blobUrl: string }
  | { status: 'too_large' }
  | { status: 'error'; message: string };

export const AudioPlayer: FC<{ source: RawFileSource; fileName: string }> = ({
  source,
  fileName,
}) => {
  const [state, setState] = useState<PlayerState>({ status: 'loading' });
  // The blob URL the webview failed to decode. Keyed by URL (and the element is
  // keyed by it too) so a late `error` from a previous file's element, e.g. when
  // its URL is revoked on a source change, can never mark the next file.
  const [failedBlobUrl, setFailedBlobUrl] = useState<string | null>(null);
  const url = rawFileUrl(source);

  useEffect(() => {
    let canceled = false;
    let createdUrl: string | null = null;
    const controller = new AbortController();

    setState({ status: 'loading' });

    (async () => {
      try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal });
        if (res.status === HTTP_PAYLOAD_TOO_LARGE) {
          if (!canceled) setState({ status: 'too_large' });
          return;
        }
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
        const blob = await res.blob();
        if (canceled) return;
        createdUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', blobUrl: createdUrl });
      } catch (err) {
        // Aborted runs are silent cleanup: the newer run (or unmount) owns state.
        if (canceled || (err instanceof Error && err.name === 'AbortError')) return;
        setState({ status: 'error', message: getErrorMessage(err, 'Failed to load audio') });
      }
    })();

    return () => {
      canceled = true;
      controller.abort();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [url]);

  return (
    <div className={styles.audioPlayer}>
      <div className={styles.audioName} title={fileName}>
        {fileName}
      </div>
      {state.status === 'loading' && (
        <div className={styles.notice} role="status">
          Loading audio…
        </div>
      )}
      {state.status === 'too_large' && (
        <div className={styles.notice} role="status">
          This file is too large to play here.
        </div>
      )}
      {state.status === 'error' && (
        <div className={styles.notice} role="alert">
          Could not load audio: {state.message}
        </div>
      )}
      {state.status === 'ready' &&
        (failedBlobUrl === state.blobUrl ? (
          <div className={styles.notice} role="alert">
            This audio format cannot be played here.
          </div>
        ) : (
          <audio
            key={state.blobUrl}
            className={styles.audio}
            controls
            preload="metadata"
            src={state.blobUrl}
            aria-label={`Play ${fileName}`}
            onError={() => setFailedBlobUrl(state.blobUrl)}
          />
        ))}
    </div>
  );
};
