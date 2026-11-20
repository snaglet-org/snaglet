import { useEffect, useState } from 'react';
import type { Calendar, CalendarDeletionPreview } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { ConfirmModal } from '@desktop/components/Modal/ConfirmModal';
import { calendarApi } from './calendarApi';
import { loadCalendars } from './calendarStore';
import { FetchError } from '@desktop/utils/api/core';

export function deletionConsequences(preview: CalendarDeletionPreview): string[] {
  return [
    ...(preview.events
      ? [
          `${preview.events} ${preview.events === 1 ? 'event will' : 'events will'} be permanently deleted, including ${preview.events === 1 ? 'its' : 'their'} reminders.`,
        ]
      : []),
    ...(preview.dateFields
      ? [
          `${preview.dateFields} date ${preview.dateFields === 1 ? 'field will' : 'fields will'} be disconnected and ${preview.dateFields === 1 ? 'its' : 'their'} reminders will stop. Tables, rows, dates and repeats will be kept.`,
        ]
      : []),
    ...(preview.automations
      ? [
          `${preview.automations} ${preview.automations === 1 ? 'automation will' : 'automations will'} no longer appear on this calendar. Their schedules and paused states will be kept.`,
        ]
      : []),
    ...(preview.events || preview.dateFields || preview.automations
      ? [
          'Counts include active and paused automations, but exclude items in the trash, inactive date fields, and canceled or finished automations.',
        ]
      : []),
    'Events in the trash and their reminders will also be permanently deleted. Inactive date fields and canceled or finished automations will be disconnected, not deleted.',
    'This cannot be undone.',
  ];
}

export function DeleteCalendarDialog({
  calendar,
  onClose,
}: {
  calendar: Calendar;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<CalendarDeletionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void calendarApi.previewDeletion(calendar.id).then(
      (value) => {
        if (alive) setPreview(value);
      },
      (err: unknown) => {
        if (!alive) return;
        if (err instanceof FetchError && err.status === 404) {
          void loadCalendars().then(onClose);
          return;
        }
        setError(getErrorMessage(err, 'Could not check this calendar'));
      }
    );
    return () => {
      alive = false;
    };
  }, [calendar.id, onClose]);
  return (
    <ConfirmModal
      title={`Delete ${calendar.title}?`}
      confirmLabel="Delete calendar"
      confirmDisabled={!preview}
      destructive
      onCancel={onClose}
      onConfirm={async () => {
        if (!preview) throw new Error(error ?? 'Still checking this calendar. Please wait.');
        try {
          await calendarApi.deleteCalendar(calendar.id, preview.token);
        } catch (err) {
          if (err instanceof FetchError && err.status === 404) {
            await loadCalendars();
            onClose();
            return;
          }
          // A stale confirmation must be read again before the next click can delete.
          setPreview(null);
          try {
            setPreview(await calendarApi.previewDeletion(calendar.id));
          } catch (refreshError) {
            if (refreshError instanceof FetchError && refreshError.status === 404) {
              await loadCalendars();
              onClose();
              return;
            }
            throw refreshError;
          }
          throw err;
        }
        await loadCalendars();
        onClose();
      }}
    >
      {preview ? deletionConsequences(preview) : (error ?? 'Checking what will be affected…')}
    </ConfirmModal>
  );
}
