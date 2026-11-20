import { useEffect, useState, type FC } from 'react';
import type { VisionPreviewFramePayload } from '@snaglet/shared/types';
import { useVisionSessionContext } from './VisionSessionContext';
import styles from './VisionTransientCaptureCards.module.scss';

const CaptureCard: FC<{ frame: VisionPreviewFramePayload }> = ({ frame }) => {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setPreviewUrl(null);
    setFailed(false);
    void fetch(frame.deliveryUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Capture delivery failed (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          return;
        }
        setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [frame.deliveryUrl]);

  return (
    <figure className={styles.card} data-testid={`vision-capture-${frame.frameId}`}>
      {failed ? (
        <div className={styles.failure} role="status">
          Capture preview unavailable
        </div>
      ) : previewUrl ? (
        <img
          src={previewUrl}
          alt={`Temporary ${frame.source} capture requested for this turn`}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className={styles.failure} role="status">
          Loading capture preview
        </div>
      )}
      <figcaption>
        <span className={styles.pulse} aria-hidden />
        <span>{failed ? 'Capture delivery failed' : 'Captured for current turn'}</span>
      </figcaption>
    </figure>
  );
};

export const VisionTransientCaptureCards: FC = () => {
  const context = useVisionSessionContext();
  const [, rerenderAtExpiry] = useState(0);
  const frames = context ? Array.from(context.transientFrames.values()) : [];

  useEffect(() => {
    if (frames.length === 0) return;
    const nextExpiry = Math.min(...frames.map((frame) => Date.parse(frame.expiresAt)));
    const delay = Math.min(2_147_483_647, Math.max(0, nextExpiry - Date.now()));
    const timeout = window.setTimeout(() => rerenderAtExpiry((value) => value + 1), delay);
    return () => window.clearTimeout(timeout);
  }, [frames]);

  const active = frames.filter((frame) => Date.parse(frame.expiresAt) > Date.now());
  if (active.length === 0) return null;
  return (
    <div className={styles.list} aria-label="Temporary vision captures">
      {active.map((frame) => (
        <CaptureCard key={frame.frameId} frame={frame} />
      ))}
    </div>
  );
};
