import { useEffect, useRef, useState, type FC } from 'react';
import type { VisionPreviewFramePayload, VisionSessionSource } from '@snaglet/shared/types';
import { Button } from '@desktop/components/controls/Button/Button';
import { useVisionSessionContext } from './VisionSessionContext';
import styles from './VisionPreviewPanel.module.scss';

function sourceName(source: VisionSessionSource | null): string {
  if (source === 'screen') return 'Screen';
  if (source === 'camera') return 'Camera';
  if (source === 'both') return 'Screen + Camera';
  return 'Vision';
}

function PreviewTile({
  source,
  stream,
  captureFrameId,
}: {
  source: VisionPreviewFramePayload['source'];
  stream?: MediaStream;
  captureFrameId?: string;
}) {
  const label = source === 'screen' ? 'Screen' : 'Camera';
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream ?? null;
  }, [stream]);
  return (
    <figure className={styles.tile} data-source={source} data-testid={`vision-preview-${source}`}>
      <div className={styles.stage}>
        {stream ? (
          <video
            ref={videoRef}
            aria-label={`Live local ${label.toLowerCase()} preview`}
            autoPlay
            muted
            playsInline
          />
        ) : (
          <div className={styles.waiting} role="status">
            <span className={styles.aperture} aria-hidden />
            Starting local {label.toLowerCase()} preview
          </div>
        )}
        {captureFrameId && (
          <span
            key={captureFrameId}
            className={styles.captureFlash}
            data-testid={`vision-preview-${source}-capture-flash`}
            aria-hidden
          />
        )}
        <span className={`${styles.corner} ${styles.topLeft}`} aria-hidden />
        <span className={`${styles.corner} ${styles.topRight}`} aria-hidden />
        <span className={`${styles.corner} ${styles.bottomLeft}`} aria-hidden />
        <span className={`${styles.corner} ${styles.bottomRight}`} aria-hidden />
      </div>
      <figcaption>
        <span>{label}</span>
        <span>Local only</span>
      </figcaption>
    </figure>
  );
}

export const VisionPreviewPanel: FC = () => {
  const context = useVisionSessionContext();
  const [collapsed, setCollapsed] = useState(false);
  const state = context?.state;
  if (!context || !state?.enabled) return null;

  const { stop } = context;
  const sources: VisionPreviewFramePayload['source'][] =
    state.source === 'both' ? ['screen', 'camera'] : [state.source ?? 'screen'];
  const transitioning = state.phase === 'starting' || state.phase === 'stopping';
  const status = state.phase === 'stopping' ? 'Stopping' : state.ready ? 'Access on' : 'Starting';

  return (
    <section className={styles.panel} aria-label="Vision access preview" data-phase={state.phase}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <span className={styles.liveDot} aria-hidden />
          <span className={styles.title}>{sourceName(state.source)} access</span>
          <span className={styles.status}>{status}</span>
        </div>
        <div className={styles.actions}>
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? 'Show' : 'Hide'}
          </Button>
          <Button variant="danger" size="xs" disabled={transitioning} onClick={stop}>
            Stop
          </Button>
        </div>
      </header>
      {!collapsed && (
        <div className={styles.grid} data-layout={state.source === 'both' ? 'both' : 'single'}>
          {sources.map((source) => (
            <PreviewTile
              key={source}
              source={source}
              stream={context.localStreams[source]}
              captureFrameId={context.previewFrames[source]?.frameId}
            />
          ))}
          {context.localPreviewError && (
            <div className={styles.waiting} role="alert">
              {context.localPreviewError}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
