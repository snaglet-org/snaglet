/** App-only permanent deletion. The tool surface deliberately exposes neither operation. */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { transaction, type DbQueryable } from '@snaglet/db/db';
import {
  Calendars,
  calendarBadRequest,
  calendarConflict,
  calendarNotFound,
  lockCalendarCatalog,
} from '@snaglet/db/tables/calendars';
import { AuthError } from '@snaglet/shared/utils';
import { ErrorCode, type CalendarDeletionPreview } from '@snaglet/shared/types';
import { getPanelToken } from '@server/middleware/panelAuth';
import { emitAutomationsChanged } from '@server/realtime/surfaces/automations';
import { emitCalendarChanged } from '@server/realtime/surfaces/calendar';
import { emitTableFieldsChanged } from '@server/realtime/surfaces/tables';

/** Unlike panelAuthMiddleware, never accepts the CLI/agent sidecar credential. */
export function calendarDeletionAuth(req: Request, _res: Response, next: NextFunction): void {
  const supplied = Buffer.from(req.get('x-snaglet-panel-token') ?? '');
  const expected = Buffer.from(getPanelToken());
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    next(new AuthError('Calendar deletion requires the app confirmation.', ErrorCode.FORBIDDEN));
    return;
  }
  next();
}

async function inspect(
  id: string,
  tx: DbQueryable,
  lock = false
): Promise<CalendarDeletionPreview> {
  if (lock) {
    // Bound the wait, including catalog acquisition. Existing writers may hold
    // a child before requesting the catalog; a timeout rolls everything back.
    await tx.query("SET LOCAL lock_timeout = '750ms'");
    await lockCalendarCatalog(tx);
  }
  const calendar = lock ? await Calendars.lockById(id, tx) : await Calendars.findById(id, tx);
  if (!calendar) throw calendarNotFound();
  // The parent FOR UPDATE blocks new FK bindings. Lock nodes before events:
  // generic node archive uses that order. Event writers may lock in reverse;
  // the bounded wait above safely aborts either cycle without partial deletion.
  if (lock)
    await tx.query(
      `SELECT n.id FROM public.nodes n JOIN public.calendar_events e ON e.id = n.id
     WHERE e.calendar_id = $1 ORDER BY n.id FOR UPDATE OF n`,
      [id]
    );
  const { rows: events } = await tx.query(
    `SELECT e.id, e.revision, n.archived FROM public.calendar_events e
     JOIN public.nodes n ON n.id = e.id WHERE e.calendar_id = $1 ORDER BY e.id${lock ? ' FOR UPDATE OF e' : ''}`,
    [id]
  );
  const { rows: fields } = await tx.query(
    `SELECT id, table_id, revision, state FROM public.table_fields WHERE calendar_id = $1 ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [id]
  );
  const { rows: automations } = await tx.query(
    `SELECT id, updated_at, status FROM public.automations WHERE calendar_id = $1 ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
    [id]
  );
  // Fingerprint all affected records, not just the visible counts below.
  const token = createHash('sha256')
    .update(JSON.stringify({ calendar, events, fields, automations }))
    .digest('hex');
  return {
    token,
    events: events.filter((event) => !event.archived).length,
    dateFields: fields.filter((field) => field.state === 'active').length,
    automations: automations.filter((automation) =>
      ['active', 'paused'].includes(automation.status)
    ).length,
  };
}

export function previewCalendarDeletion(id: string): Promise<CalendarDeletionPreview> {
  return transaction((tx) => inspect(id, tx));
}

export async function deleteCalendar(id: string, token: unknown): Promise<{ id: string }> {
  if (typeof token !== 'string' || !token)
    throw calendarBadRequest('Confirm the calendar deletion first.');
  const tableIds = await transaction(async (tx) => {
    const current = await inspect(id, tx, true);
    if (current.token !== token)
      throw calendarConflict('This calendar changed. Review the deletion again.');
    const { rows: fields } = await tx.query<{ table_id: string }>(
      `UPDATE public.table_fields SET calendar_id = NULL, revision = revision + 1, updated_at = now()
       WHERE calendar_id = $1 RETURNING table_id`,
      [id]
    );
    await tx.query(
      'UPDATE public.automations SET calendar_id = NULL, updated_at = now() WHERE calendar_id = $1',
      [id]
    );
    // Table occurrences are projections, not native event rows. Their dates,
    // repeats, reminders, history and rows are untouched. Other workspace
    // nodes are not deleted.
    await tx.query(
      `DELETE FROM public.nodes WHERE id IN
      (SELECT id FROM public.calendar_events WHERE calendar_id = $1 AND recurring_event_id IS NOT NULL)`,
      [id]
    );
    await tx.query(
      `DELETE FROM public.nodes WHERE id IN
      (SELECT id FROM public.calendar_events WHERE calendar_id = $1)`,
      [id]
    );
    await tx.query('DELETE FROM public.calendars WHERE id = $1', [id]);
    await tx.query(`UPDATE public.calendars SET is_default = true, revision = revision + 1, updated_at = now()
      WHERE id = (SELECT id FROM public.calendars ORDER BY sort_order, created_at, id LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM public.calendars WHERE is_default)`);
    return [...new Set(fields.map((field) => field.table_id))];
  }).catch((error: unknown) => {
    if (['55P03', '40P01'].includes((error as { code?: string }).code ?? ''))
      throw calendarConflict('Calendar data is being edited. Please try again.');
    throw error;
  });
  for (const tableId of tableIds) emitTableFieldsChanged(tableId);
  emitAutomationsChanged();
  emitCalendarChanged({ kind: 'calendar', calendarId: id });
  return { id };
}
