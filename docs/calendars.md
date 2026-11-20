# Calendars

The **Calendar**, in the activity bar, puts events, dated table rows and automations on one
timeline, and reminds you of anything with a start time.

## Using it

- **Events** you add show as filled blocks. **Table rows** show by a date field, outlined with
  the table's name. **Automations** show a block per wake, or a dot per run for "every 15
  minutes" ones.
- Views: **Month**, **Week**, **Day** and **Year**. In Week and Day, **Ctrl/Cmd + scroll** or a
  pinch zooms.
- A **Default calendar** appears when one is first needed. Add more, drag to reorder, hide with
  the eye icon, or recolor with the color dot. Deleting one is permanent and asks first: its
  events go, its date fields disconnect (table data stays), and its automations keep running.
- **＋ Add a date field** under a calendar, or **Show on calendar** in a field's settings, shows a
  table's dates: all-day, a 30-minute block for a time, a span for a range. A field's number
  counts rows with no date.
- Drag across a time (Week, Day) or click an empty day (Month) to add an event. Pick a
  **Table field** in its popover to make a row instead; an existing event converts the same way,
  keeping its description and location.
- Drag anything to move it (a row's date changes with it), or its edge to resize. Click a row to
  edit it in place, mark it done or open it. Every change offers **Undo** (**Cmd/Ctrl+Z** while
  the Calendar is active).
- Events repeat daily, weekly, monthly, yearly or custom, as one series with no **Done** or
  **Skip**. Moving one occurrence of a repeating row asks **Only this one** or **All upcoming**
  ([Repeating rows](./tables.md#repeating-rows)).
- Calendar events don't appear in search, and calendars don't sync with Google Calendar.

## Reminders

- Timed events, timed rows on a calendar and automations can remind you. All-day items can't.
- Turn on the item's **Notify** section (calendar popover, row window or automation form) and
  pick **At start time**, **Add reminder** ("15 minutes before") and a **Sound**.
- A due reminder shows a top-right banner with **Open**. On macOS a system notification comes
  too, even in the background; allow it in **System Settings → Notifications → Snaglet**.
- On start or wake, Snaglet shows reminders due in the last 10 minutes and skips older ones.

## How it's built

- `GET /api/calendar/occurrences` (`apps/server/src/domains/calendar/occurrences.ts`) merges
  events, bound rows and automations; nothing is copied.
- `calendars` holds time zone, color and order. Events are `calendar_events` rows backed by
  `calendar_event` nodes. Date fields bind through `table_fields.calendar_id`. The calendar edits
  rows only through the table API, so each change is an undo step.
- Only the app can delete a calendar (`apps/server/src/domains/calendar/calendarDeletion.ts`);
  agent tools and the CLI can't.
- Reminders: `reminder_settings` per item and `reminder_deliveries` so each fires once, fired by
  `apps/server/src/domains/reminders/reminderScheduler.ts`. The banner and macOS sync are in
  `apps/desktop-ui/src/features/reminders/`.
- UI: `apps/desktop-ui/src/pages/Dashboard/views/CalendarView/` and
  `apps/desktop-ui/src/features/calendar/`. Agents use the `calendar` tool.
- More: [Architecture](./architecture.md#data-model).

## Related

- [Tables](./tables.md)
- [Automations](./automations.md)
- [Search](./search.md)
- [The interface](./ui.md)
