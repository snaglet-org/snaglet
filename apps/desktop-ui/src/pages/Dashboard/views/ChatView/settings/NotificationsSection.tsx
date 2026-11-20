import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import {
  REMINDER_SOUNDS,
  type ReminderSoundId,
  type ThreadNotificationSettings,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { Checkbox, Section, Select } from '@desktop/components';
import { PlayIcon } from '@desktop/components/Icons';
import {
  REMINDER_SOUND_LABELS,
  playReminderSound,
} from '@desktop/features/reminders/reminderSounds';
import { nativeNotifications } from '@desktop/features/reminders/nativeNotifications';
import { threadsApi } from '@desktop/utils/api';
import styles from './ChatSettings.module.scss';

/** The single checkbox's label (and accessible name). */
const NOTIFY_LABEL = 'Send a notification for when any agent in this thread run ends';

/**
 * Notifications: one row in the General tab with a checkbox and the sound
 * picker (the reminder sounds). The checkbox writes the three stored flags
 * (`enabled`, `onCompleted`, `onFailed`) together; with only one outcome on it
 * shows as indeterminate. Each change saves through
 * PUT /api/threads/:id/notification-settings. Turning it on asks for OS
 * notification permission the first time.
 */
interface NotificationsSectionProps {
  threadId: string;
}

export const NotificationsSection: FC<NotificationsSectionProps> = ({ threadId }) => {
  const [settings, setSettings] = useState<ThreadNotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nativeDenied, setNativeDenied] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    setSettings(null);
    void threadsApi
      .getNotificationSettings(threadId)
      .then((loaded) => {
        if (live) setSettings(loaded);
      })
      .catch((err: unknown) => {
        if (live) setError(getErrorMessage(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [threadId]);

  const anyOutcome = Boolean(settings?.enabled && (settings.onCompleted || settings.onFailed));

  // Whether the OS would actually show the banner. Only worth asking while on.
  useEffect(() => {
    if (!anyOutcome) {
      setNativeDenied(false);
      return;
    }
    let live = true;
    void nativeNotifications.status().then((status) => {
      if (live) setNativeDenied(status.supported && status.permission === 'denied');
    });
    return () => {
      live = false;
    };
  }, [anyOutcome]);

  const save = useCallback(
    (next: ThreadNotificationSettings) => {
      setSettings(next);
      setSaving(true);
      setError(null);
      void threadsApi
        .setNotificationSettings(threadId, {
          enabled: next.enabled,
          sound: next.sound,
          onCompleted: next.onCompleted,
          onFailed: next.onFailed,
        })
        .then((saved) => {
          if (mounted.current) setSettings(saved);
        })
        .catch((err: unknown) => {
          if (mounted.current) setError(getErrorMessage(err));
        })
        .finally(() => {
          if (mounted.current) setSaving(false);
        });
    },
    [threadId]
  );

  const allOn = Boolean(settings?.enabled && settings.onCompleted && settings.onFailed);
  const partial = anyOutcome && !allOn;

  const toggle = useCallback(() => {
    if (!settings) return;
    // Checked → off; unchecked or partial → on for both outcomes.
    const on = !allOn;
    save({ ...settings, enabled: on, onCompleted: on, onFailed: on });
    if (!on) return;
    // The first time: ask the OS (macOS shows its prompt once).
    void (async () => {
      let status = await nativeNotifications.status();
      if (status.supported && status.permission === 'unknown') {
        status = await nativeNotifications.requestPermission();
      }
      if (mounted.current) setNativeDenied(status.supported && status.permission === 'denied');
    })();
  }, [allOn, save, settings]);

  return (
    <Section label="Notifications">
      {loading && <p className={styles.routingPlaceholder}>Loading…</p>}
      {/* No settings and not loading = the load failed; the error below says why. */}
      {!loading && settings && (
        <div className={styles.notifyRow}>
          <Checkbox
            checked={allOn}
            indeterminate={partial}
            disabled={saving}
            onChange={toggle}
            className={styles.notifyCheckbox}
          >
            {NOTIFY_LABEL}
          </Checkbox>
          <div className={styles.notifySoundRow} data-enabled={anyOutcome}>
            <span>Sound</span>
            <Select
              size="sm"
              aria-label="Run notification sound"
              value={settings.sound}
              disabled={!anyOutcome || saving}
              onChange={(e) => save({ ...settings, sound: e.target.value as ReminderSoundId })}
            >
              {REMINDER_SOUNDS.map((sound) => (
                <option key={sound} value={sound}>
                  {REMINDER_SOUND_LABELS[sound]}
                </option>
              ))}
            </Select>
            <button
              type="button"
              className={styles.notifySoundPreview}
              aria-label={`Play ${REMINDER_SOUND_LABELS[settings.sound]}`}
              title="Play"
              disabled={settings.sound === 'none'}
              onClick={() => playReminderSound(settings.sound)}
            >
              <PlayIcon />
            </button>
          </div>
        </div>
      )}

      {anyOutcome && nativeDenied && (
        <p className={styles.sectionDescription}>
          System notifications are off for Snaglet, so only the sound plays. Turn them on in System
          Settings → Notifications → Snaglet.
        </p>
      )}

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
    </Section>
  );
};
