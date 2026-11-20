import { useEffect, useRef, useState, type FC } from 'react';
import type { VisionSessionSource } from '@snaglet/shared/types';
import { Button } from '@desktop/components/controls/Button/Button';
import { VisionIcon } from '@desktop/components/Icons';
import { useVisionSessionContext } from './VisionSessionContext';
import styles from './VisionComposerControl.module.scss';

const MODES: ReadonlyArray<{
  source: VisionSessionSource;
  label: string;
  description: string;
  glyph: string;
}> = [
  {
    source: 'screen',
    label: 'Screen share',
    description: 'Allow one fresh screen frame when needed',
    glyph: '▣',
  },
  {
    source: 'camera',
    label: 'Camera',
    description: 'Allow one fresh camera frame when needed',
    glyph: '◉',
  },
  { source: 'both', label: 'Both', description: 'Allow either source on demand', glyph: '▦' },
];

function sourceLabel(source: VisionSessionSource | null): string {
  if (source === 'screen') return 'Screen';
  if (source === 'camera') return 'Camera';
  if (source === 'both') return 'Both';
  return 'Vision';
}

const VisionComposerControlInner: FC = () => {
  const context = useVisionSessionContext();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  if (!context) return null;
  const { state, error, start, stop } = context;
  const transitioning = state.phase === 'starting' || state.phase === 'stopping';
  const active = state.enabled || transitioning;
  const name = sourceLabel(state.source);
  const label =
    state.phase === 'starting'
      ? `Starting ${name}`
      : state.phase === 'stopping'
        ? `Stopping ${name}`
        : state.phase === 'error'
          ? 'Vision error'
          : state.phase === 'active'
            ? `${name} ${state.ready ? 'access on' : 'starting'}`
            : 'Vision';

  return (
    <div className={styles.root} ref={rootRef} data-testid="vision-session-control">
      <Button
        variant={active ? 'primary' : 'ghost'}
        size="md"
        leftIcon={<VisionIcon />}
        aria-pressed={active}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={active ? `${label} — change or stop vision access` : 'Enable vision access'}
        onClick={() => {
          setOpen((value) => !value);
        }}
        data-testid="vision-mode-button"
        data-phase={state.phase}
        data-source={state.source ?? undefined}
      >
        <span className={styles.buttonLabel}>
          <span className={active ? styles.liveDot : styles.idleDot} aria-hidden />
          {label}
        </span>
      </Button>

      {open && (
        <div className={styles.popover} role="dialog" aria-label="Vision mode">
          <div className={styles.heading}>
            <span>Vision access</span>
            <span className={styles.headingStatus}>{active ? label : 'Off'}</span>
          </div>
          <div className={styles.modeList}>
            {MODES.map((mode) => (
              <button
                type="button"
                className={styles.mode}
                key={mode.source}
                aria-pressed={state.enabled && state.source === mode.source}
                disabled={transitioning}
                onClick={() => {
                  start(mode.source);
                  setOpen(false);
                }}
              >
                <span className={styles.modeGlyph} aria-hidden>
                  {mode.glyph}
                </span>
                <span className={styles.modeCopy}>
                  <strong>{mode.label}</strong>
                  <small>{mode.description}</small>
                </span>
                {state.enabled && state.source === mode.source && (
                  <span className={styles.selected} aria-label="Selected">
                    ON
                  </span>
                )}
              </button>
            ))}
          </div>
          {active && (
            <Button
              variant="danger"
              size="sm"
              fullWidth
              disabled={transitioning}
              onClick={() => {
                stop();
                setOpen(false);
              }}
            >
              Stop vision access
            </Button>
          )}
        </div>
      )}

      {error && (
        <span className={styles.error} role="alert" title={error}>
          {error}
        </span>
      )}
    </div>
  );
};

/** Composer entry point; its shared provider also owns the in-thread preview. */
export const VisionComposerControl: FC = () => <VisionComposerControlInner />;
