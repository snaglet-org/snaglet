/**
 * A calendar's color (sidebar swatch, or ⋯ → Color): the workspace theme's
 * colors, the calendar's custom color with recent ones, ＋ for a new custom
 * color, and Automatic. A theme swatch stores its token (`theme:detail`), so
 * the calendar follows theme edits; only a custom color stores a hex.
 *
 * ＋ opens the custom picker as a layer of its own: a color well and a hex
 * field that save only on Save or Enter. One outside press or Escape closes
 * the innermost open layer only (the picker, then the popover), never saving.
 */
import { useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { CalendarColor } from '@snaglet/shared/types';
import { calendarColorParts, normalizeHexColor } from '@snaglet/shared/utils';
import { Button, TextInput } from '@desktop/components';
import { useWorkspaceSwatches } from './colorSwatches';
import { rememberRecentColor, useRecentColors } from './colorSwatches';
import { AnchoredSurface } from './AnchoredSurface';
import { calendarColorProps, inkOn, liveThemeHex } from './calendarColors';
import styles from './CalendarPopovers.module.scss';

/** Custom colors shown (the calendar's own first, then recent picks): one row with ＋. */
const MAX_CUSTOM_SWATCHES = 6;

export interface CalendarColorPopoverProps {
  anchor: HTMLElement;
  /** The calendar's stored color; null = automatic. */
  value: CalendarColor | null;
  /** A pick: a theme token, a custom hex, or null for automatic. */
  onPick: (color: CalendarColor | null) => void;
  onDismiss: () => void;
}

/** The picker's starting color: the calendar's own when it has a hex, else the one it shows. */
function startingHex(value: CalendarColor | null, anchor: HTMLElement): string {
  const parts = calendarColorParts(value);
  if (parts?.kind === 'custom') return parts.color;
  if (parts?.kind === 'theme') {
    const hex = liveThemeHex(parts.token);
    if (hex) return hex;
  }
  const painted = normalizeHexColor(getComputedStyle(anchor).getPropertyValue('--cal-accent'));
  return painted ?? liveThemeHex('detail') ?? '#000000';
}

export function CalendarColorPopover({
  anchor,
  value,
  onPick,
  onDismiss,
}: CalendarColorPopoverProps) {
  const uid = useId();
  const swatches = useWorkspaceSwatches(true);
  const recent = useRecentColors();
  const addRef = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const parts = calendarColorParts(value);
  const own = parts?.kind === 'custom' ? parts.color : null;
  const customs = [...(own ? [own] : []), ...recent.filter((hex) => hex !== own)].slice(
    0,
    MAX_CUSTOM_SWATCHES
  );

  const pickCustom = (hex: string) => {
    const color = normalizeHexColor(hex);
    if (!color) return;
    rememberRecentColor(color);
    onPick(color);
  };
  // Escape while focus is still in the popover closes the open picker first.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !picking) return;
    e.preventDefault();
    e.stopPropagation();
    setPicking(false);
  };

  return (
    <AnchoredSurface anchor={anchor} label="Calendar color" width={232} onDismiss={onDismiss}>
      <div className={styles.colorBody} onKeyDown={onKeyDown}>
        <p className={styles.colorHeading}>Theme</p>
        <div className={styles.palette} role="group" aria-label="Theme colors">
          {swatches.map((swatch) => {
            const token = swatch.tokens[0];
            if (!token) return null;
            return (
              <button
                key={swatch.hex}
                type="button"
                className={styles.paletteSwatch}
                {...calendarColorProps(`theme:${token}`, {
                  ['--cal-on-accent' as string]: inkOn(swatch.hex),
                } as CSSProperties)}
                aria-label={swatch.label}
                title={`${swatch.label} · ${swatch.hex}`}
                aria-pressed={parts?.kind === 'theme' && swatch.tokens.includes(parts.token)}
                onClick={() => onPick(`theme:${token}`)}
              />
            );
          })}
        </div>
        <p className={styles.colorHeading}>Custom</p>
        <div className={styles.palette} role="group" aria-label="Custom colors">
          {customs.map((hex) => (
            <button
              key={hex}
              type="button"
              className={styles.paletteSwatch}
              {...calendarColorProps(hex)}
              aria-label={hex}
              title={hex}
              aria-pressed={hex === own}
              onClick={() => pickCustom(hex)}
            />
          ))}
          <button
            ref={addRef}
            type="button"
            className={styles.paletteAdd}
            aria-label="Custom color…"
            title="Pick a custom color"
            aria-haspopup="dialog"
            aria-expanded={picking}
            data-custom-color-trigger={uid}
            onClick={() => setPicking((open) => !open)}
          >
            ＋
          </button>
        </div>
        <button
          type="button"
          className={styles.paletteAuto}
          aria-pressed={value === null}
          title="A palette color picked by the calendar's place in the list"
          onClick={() => onPick(null)}
        >
          Automatic
        </button>
      </div>
      {picking && addRef.current && (
        <CustomColorPicker
          anchor={addRef.current}
          initial={startingHex(value, anchor)}
          keepOpenSelector={`[data-custom-color-trigger="${uid}"]`}
          onSave={pickCustom}
          onDismiss={() => setPicking(false)}
        />
      )}
    </AnchoredSurface>
  );
}

interface CustomColorPickerProps {
  anchor: HTMLElement;
  initial: string;
  keepOpenSelector: string;
  onSave: (hex: string) => void;
  onDismiss: () => void;
}

/** The custom color layer: a color well and a hex field, saved only on Save or Enter. */
function CustomColorPicker({
  anchor,
  initial,
  keepOpenSelector,
  onSave,
  onDismiss,
}: CustomColorPickerProps) {
  const hintId = useId();
  const [draft, setDraft] = useState(initial);
  const typed = draft.trim();
  const hex = normalizeHexColor(typed.startsWith('#') ? typed : `#${typed}`);
  const save = () => {
    if (hex) onSave(hex);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    // The picker's, not the color popover's around it.
    e.preventDefault();
    e.stopPropagation();
    onDismiss();
  };
  return (
    <AnchoredSurface
      anchor={anchor}
      label="Custom color"
      width={232}
      keepOpenSelector={keepOpenSelector}
      onDismiss={onDismiss}
    >
      <div className={styles.colorBody} onKeyDown={onKeyDown}>
        <div className={styles.row}>
          <input
            type="color"
            className={styles.colorWell}
            aria-label="Color"
            value={hex ?? initial}
            onChange={(e) => setDraft(e.target.value)}
          />
          <TextInput
            size="sm"
            className={styles.grow}
            data-autofocus=""
            aria-label="Hex color"
            aria-invalid={!hex}
            aria-describedby={hex ? undefined : hintId}
            placeholder="#3a7bd5"
            spellCheck={false}
            maxLength={7}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              save();
            }}
          />
        </div>
        {hex ? (
          <div className={styles.colorPreview} {...calendarColorProps(hex)} aria-hidden>
            <span className={styles.colorPreviewDot} />
            Sample event
          </div>
        ) : (
          <p id={hintId} className={styles.muted}>
            Use a hex color like #3a7bd5.
          </p>
        )}
        <div className={styles.footer}>
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            Cancel
          </Button>
          <Button type="button" variant="primary" size="sm" disabled={!hex} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </AnchoredSurface>
  );
}
