/**
 * The "Notify" section for a calendar item with a start time (a timed event,
 * a table row's datetime field on a calendar, an automation): a switch, "At
 * start time", any number of "[N] [minutes|hours|days] before" rows, and a
 * sound with a ▶ preview. Every change autosaves (debounced) through
 * PUT /api/reminders/settings; a pending save is sent at once when the
 * section unmounts (its popover closes). Controls are native (`<select>`,
 * inputs), so no floating layer of its own: one outside click still closes
 * just the popover around it.
 *
 * Turning reminders on asks for native notification permission the first
 * time (macOS); if it's denied, a note says only in-app banners will appear.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  DEFAULT_REMINDER_SOUND,
  REMINDER_SOUNDS,
  REMINDER_UNITS,
  type ReminderItemRef,
  type ReminderOffset,
  type ReminderSettings,
  type ReminderSoundId,
  type ReminderUnit,
  type UpdateReminderSettingsRequest,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Button, Checkbox, Select, TextInput } from '@desktop/components';
import { PlayIcon, PlusIcon } from '@desktop/components/Icons';
import { cn } from '@desktop/utils/classNames';
import { FetchError } from '@desktop/utils/api/core';
import { reminderItemQuery, remindersApi } from '@desktop/utils/api/reminders';
import { nativeNotifications } from './nativeNotifications';
import { notifyRemindersChanged } from './remindersEvents';
import { REMINDER_SOUND_LABELS, playReminderSound } from './reminderSounds';
import styles from './ReminderSettingsControl.module.scss';

/** Autosave this long after the last change. */
export const REMINDER_SAVE_DEBOUNCE_MS = 500;
const REMINDER_AMOUNT_MAX = 999;
const MAX_OFFSETS = 8;

/** Offered in turn by "+ Add reminder", skipping ones already listed. */
const SUGGESTED: ReminderOffset[] = [
  { amount: 15, unit: 'minutes' },
  { amount: 1, unit: 'hours' },
  { amount: 1, unit: 'days' },
  { amount: 5, unit: 'minutes' },
  { amount: 30, unit: 'minutes' },
  { amount: 2, unit: 'hours' },
];

const UNIT_SINGULAR: Record<ReminderUnit, string> = {
  minutes: 'minute',
  hours: 'hour',
  days: 'day',
};

interface OffsetDraft {
  id: number;
  /** As typed, so the field can be cleared and retyped. */
  amount: string;
  unit: ReminderUnit;
}

interface Draft {
  enabled: boolean;
  atStart: boolean;
  offsets: OffsetDraft[];
  sound: ReminderSoundId;
}

let nextOffsetId = 1;
const offsetDraft = (o: ReminderOffset): OffsetDraft => ({
  id: nextOffsetId++,
  amount: String(o.amount),
  unit: o.unit,
});

function draftFrom(settings: ReminderSettings | null): Draft {
  if (!settings) {
    return { enabled: false, atStart: true, offsets: [], sound: DEFAULT_REMINDER_SOUND };
  }
  return {
    enabled: settings.enabled,
    atStart: settings.atStart,
    offsets: settings.offsets.map(offsetDraft),
    sound: (REMINDER_SOUNDS as readonly string[]).includes(settings.sound)
      ? settings.sound
      : DEFAULT_REMINDER_SOUND,
  };
}

/** A whole number from 1 to {@link REMINDER_AMOUNT_MAX}, else null. */
function parseReminderAmount(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 && n <= REMINDER_AMOUNT_MAX ? n : null;
}

/** The PUT body for a draft, or null while an amount is invalid. Duplicates are dropped. */
function requestFrom(draft: Draft): UpdateReminderSettingsRequest | null {
  const offsets: ReminderOffset[] = [];
  const seen = new Set<string>();
  for (const o of draft.offsets) {
    const amount = parseReminderAmount(o.amount);
    if (amount === null) return null;
    const key = `${amount}:${o.unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    offsets.push({ amount, unit: o.unit });
  }
  return { enabled: draft.enabled, atStart: draft.atStart, offsets, sound: draft.sound };
}

const DEFAULT_LABEL = 'Notify';

export interface ReminderSettingsControlProps {
  item: ReminderItemRef;
  /** The section's heading. */
  label?: string;
  className?: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready' }
  /** The server has no reminders for this (for example, a deleted item). */
  | { status: 'unavailable' };

export function ReminderSettingsControl({
  item,
  label = DEFAULT_LABEL,
  className,
}: ReminderSettingsControlProps) {
  const itemKey = reminderItemQuery(item);
  const headingId = useId();
  const errorId = useId();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [nativeDenied, setNativeDenied] = useState(false);
  const [reloads, setReloads] = useState(0);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** The latest unsaved body and the item it belongs to. */
  const pending = useRef<{ item: ReminderItemRef; body: UpdateReminderSettingsRequest } | null>(
    null
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    remindersApi
      .updateSettings(next.item, next.body)
      .then(() => {
        notifyRemindersChanged();
        if (mounted.current) setSaveError(null);
      })
      .catch((err: unknown) => {
        if (mounted.current) {
          setSaveError(`Couldn't save reminders: ${getErrorMessage(err, 'request failed')}`);
        }
      });
  }, []);

  // A change still waiting is sent when the item changes or the section goes.
  useEffect(() => () => send(), [itemKey, send]);

  useEffect(() => {
    let live = true;
    setLoad({ status: 'loading' });
    setSaveError(null);
    remindersApi
      .getSettings(item)
      .then(({ settings }) => {
        if (!live) return;
        setDraft(draftFrom(settings));
        setLoad({ status: 'ready' });
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof FetchError && err.status === 404) {
          setLoad({ status: 'unavailable' });
          return;
        }
        setLoad({
          status: 'error',
          message: `Couldn't load reminders: ${getErrorMessage(err, 'request failed')}`,
        });
      });
    return () => {
      live = false;
    };
    // `itemKey` stands for `item` (a fresh object each render).
  }, [itemKey, reloads]);

  // Reminders on and native notifications denied: say only banners will show.
  const enabled = load.status === 'ready' && draft.enabled;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void nativeNotifications.status().then((status) => {
      if (live) setNativeDenied(status.supported && status.permission === 'denied');
    });
    return () => {
      live = false;
    };
  }, [enabled]);

  const change = (next: Draft) => {
    setDraft(next);
    const body = requestFrom(next);
    if (!body) {
      // Wait for a valid amount; nothing older is sent in its place.
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      return;
    }
    pending.current = { item, body };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(send, REMINDER_SAVE_DEBOUNCE_MS);
  };

  const turn = (on: boolean) => {
    change({ ...draft, enabled: on });
    if (!on) return;
    // The first time: ask the OS (macOS shows its prompt once).
    void (async () => {
      let status = await nativeNotifications.status();
      if (status.supported && status.permission === 'unknown') {
        status = await nativeNotifications.requestPermission();
        // Just granted: schedule what's already upcoming.
        if (status.permission === 'granted') notifyRemindersChanged();
      }
      if (mounted.current) setNativeDenied(status.supported && status.permission === 'denied');
    })();
  };

  const setOffset = (id: number, patch: Partial<OffsetDraft>) =>
    change({
      ...draft,
      offsets: draft.offsets.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    });

  const addOffset = () => {
    const taken = new Set(
      draft.offsets.map((o) => `${parseReminderAmount(o.amount) ?? o.amount}:${o.unit}`)
    );
    const pick = SUGGESTED.find((o) => !taken.has(`${o.amount}:${o.unit}`)) ?? SUGGESTED[0];
    change({ ...draft, offsets: [...draft.offsets, offsetDraft(pick)] });
  };

  const removeOffset = (id: number) =>
    change({ ...draft, offsets: draft.offsets.filter((o) => o.id !== id) });

  if (load.status === 'unavailable') return null;

  const invalid = draft.offsets.some((o) => parseReminderAmount(o.amount) === null);
  const nothingToFire = draft.enabled && !draft.atStart && draft.offsets.length === 0;

  return (
    <section
      className={cn(styles.section, className)}
      aria-labelledby={headingId}
      data-reminder-settings=""
    >
      <div className={styles.header}>
        {/* The heading names the section ("Notify · Due"). A bare "Notify"
            only repeats the button, so it stays for screen readers only; a
            qualified one tells two date fields' sections apart. */}
        <span id={headingId} className={label === DEFAULT_LABEL ? styles.srOnly : styles.heading}>
          {label}
        </span>
        <Button
          size="sm"
          variant={draft.enabled ? 'ghost' : 'neutral'}
          disabled={load.status !== 'ready'}
          onClick={() => turn(!draft.enabled)}
          data-reminder-toggle=""
        >
          {draft.enabled ? 'Disable notification' : 'Enable notification'}
        </Button>
      </div>

      {load.status === 'error' && (
        <p className={styles.muted}>
          {load.message}{' '}
          <Button size="xs" variant="link" onClick={() => setReloads((n) => n + 1)}>
            Retry
          </Button>
        </p>
      )}

      {enabled && (
        <div className={styles.body}>
          <Checkbox
            size="sm"
            checked={draft.atStart}
            onChange={(next) => change({ ...draft, atStart: next })}
          >
            At start time
          </Checkbox>

          {draft.offsets.length > 0 && (
            <ul className={styles.offsets} aria-label="Reminders before the start">
              {draft.offsets.map((o, index) => {
                const bad = parseReminderAmount(o.amount) === null;
                const one = o.amount.trim() === '1';
                return (
                  <li key={o.id} className={styles.offset}>
                    <TextInput
                      size="sm"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={REMINDER_AMOUNT_MAX}
                      step={1}
                      containerClassName={styles.amount}
                      aria-label={`Reminder ${index + 1} amount`}
                      aria-invalid={bad || undefined}
                      aria-describedby={bad ? errorId : undefined}
                      value={o.amount}
                      onChange={(e) => setOffset(o.id, { amount: e.target.value })}
                      onKeyDown={(e) => {
                        // Inside a form (the automation editor) Enter must not submit it.
                        if (e.key === 'Enter') e.preventDefault();
                      }}
                    />
                    <Select
                      size="sm"
                      aria-label={`Reminder ${index + 1} unit`}
                      value={o.unit}
                      onChange={(e) => setOffset(o.id, { unit: e.target.value as ReminderUnit })}
                    >
                      {REMINDER_UNITS.map((unit) => (
                        <option key={unit} value={unit}>
                          {one ? UNIT_SINGULAR[unit] : unit}
                        </option>
                      ))}
                    </Select>
                    <span className={styles.before}>before</span>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={`Remove reminder ${index + 1}`}
                      title="Remove"
                      onClick={() => removeOffset(o.id)}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {invalid && (
            <p id={errorId} className={styles.error} role="alert">
              Use a whole number from 1 to {REMINDER_AMOUNT_MAX}.
            </p>
          )}
          {draft.offsets.length < MAX_OFFSETS && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className={styles.add}
              leftIcon={<PlusIcon />}
              onClick={addOffset}
            >
              Add reminder
            </Button>
          )}
          {nothingToFire && <p className={styles.muted}>Pick At start time or add a reminder.</p>}

          <div className={styles.soundRow}>
            <span className={styles.label}>Sound</span>
            <Select
              size="sm"
              aria-label="Reminder sound"
              value={draft.sound}
              onChange={(e) => change({ ...draft, sound: e.target.value as ReminderSoundId })}
            >
              {REMINDER_SOUNDS.map((sound) => (
                <option key={sound} value={sound}>
                  {REMINDER_SOUND_LABELS[sound]}
                </option>
              ))}
            </Select>
            <button
              type="button"
              className={styles.iconButton}
              aria-label={`Play ${REMINDER_SOUND_LABELS[draft.sound]}`}
              title="Play"
              disabled={draft.sound === 'none'}
              onClick={() => playReminderSound(draft.sound)}
            >
              <PlayIcon />
            </button>
          </div>

          {nativeDenied && (
            <p className={styles.muted}>
              Only in-app banners will appear. To get system notifications, turn them on in System
              Settings → Notifications → Snaglet.
            </p>
          )}
        </div>
      )}

      {saveError && (
        <p className={styles.error} role="alert">
          {saveError}
        </p>
      )}
    </section>
  );
}
