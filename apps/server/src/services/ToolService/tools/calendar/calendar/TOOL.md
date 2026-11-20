# calendar

Snaglet's own calendars (not Google): single **events**, **table rows** whose date
field is shown on a calendar, and **automation** wakes. Every call carries
`op`; a field that belongs to another op is refused before anything runs.
Results are compact JSON. Writes need the `rev` a read returned; a stale one
is refused with the current rev.

## Read

- `query` — what is on the calendar in a span, sorted by start.
  - Span: `range` (`today`, `tomorrow`, `this_week`, `next_week`,
    `this_month`; weeks start Monday), or `days` (N days from `from`, default
    today), or `from` + `to` (`to` is exclusive: from `2026-10-15` to
    `2026-10-16` is one day). `from` alone is that one day. Nothing at all is
    the next 7 days. Dates or date-times; at most 62 days.
  - `tz`: the zone for the span and the times shown. Default: the zone of
    the one calendar you named, else the user's.
  - Filters: `kinds` (`events`, `table_rows`, `automations`; default all,
    only `table_rows` when `tables` is given), `calendars` (names or ids),
    `tables` (names or ids), `repeats` (`include` | `exclude` | `only`),
    `status` (`upcoming`, `done`, `skipped`, `moved`), `text` (title
    contains), `project_id` (only that project's tables' rows).
  - `fields`: the row fields to return in `values` (default: the table's
    first select fields, e.g. a status).
  - Paging: `limit` (1-200, default 50); pass `next` back as `cursor`.
  - A row that repeats very often (e.g. every minute) shows at most 500
    times in one read; such rows are listed in `truncated` with `shown`.
    Query a shorter span for the rest. A row repeating more often than once
    a minute is not listed at all: it is in `truncated` with `hidden: true`
    (`shown: 0`), and query, `focus` and `dates` say so in `notes`; read it
    with the `table` tool.
- `focus` — what to do next, ranked, as the calendar's Focus list ranks it:
  rows (not events) that are overdue (longest first), due today, or due
  tomorrow. `date` (default today), `tz`, `calendars`, `project_id`;
  `limit` 1-50 (default 10) for `next`, with the following ones in
  `coming_up`. Each item has `rank`, `kind` (`row`), `title`, `why`
  and what `complete_occurrence` / `skip_occurrence` need (`table`, `entry_id`,
  `field_id`, `rev`, `occurrence`). Looks back 30 days for overdue rows.
  Needs table read access.
- `dates` — the days of a year worth marking, as the Year view circles
  them: one-off events and rows on a date, and repeats that land only a few
  times a year (every year, quarterly, twice a year; counted from what the
  year holds, 12 or fewer). Frequent repeats (daily, weekly) are
  left out. `date`: any day of the year (default today); `from`: only days
  from this one; `limit` 1-200 days (default 60). Result `days`, each `{day,
items}` with `kind`, `title`, `start`/`end` when timed, `repeats`, `status`
  and the ids and `rev` to act on it. Rows need table read access.
- `list` — calendars with `tz`, color and `rev`, and `bound_fields`: the
  table date fields shown on each.
- `get_event` — `{id}`: one event with description and location.
- `get_reminders` — an item's reminder settings, or `null`.

```json
{"op": "focus"}
{"op": "dates", "from": "2026-10-21"}
{"op": "query", "range": "this_week", "kinds": ["table_rows"], "status": ["upcoming"], "fields": ["status", "owner"]}
{"op": "query", "from": "2026-10-20", "days": 3, "calendars": ["Work"], "text": "review"}
```

Each occurrence has `kind`, `title`, `start`, `end`, `all_day`, `calendar`
and `status`. Timed items show ISO with an offset
(`2026-10-15T09:00:00-07:00`); all-day items show dates, `end` being the
last day. Plus, by kind:

- `event`: `event_id`, `rev`.
- `table_row`: `table`, `table_id`, `entry_id`, `field`, `field_id`, `rev`
  (the row's), `values`, and on a repeating row `repeat`: `occurrence` (its
  id for the occurrence ops), `current` (the row's current one), `summary`,
  and when they apply `overdue`, `moved_from`.
- `automation`: `automation_id`, `agent`, `repeats`.

Every-N automations (a line on the calendar, not single wakes) come once each
in `intervals` (`every`, `next_run`), left out by a `status` filter or
`repeats: "exclude"`.

## Calendars

- `create_calendar` — `title`, optional `description`, `color` (`#rgb` or
  `#rrggbb`) and `tz` (IANA zone, default the user's). Returns the calendar
  with its `id` and `rev`; use the title or id as `calendar` on events.

```json
{ "op": "create_calendar", "title": "Work", "color": "#3366cc", "tz": "America/New_York" }
```

## Events

Single events only (rows already repeat). Times are a date-time in `tz`
(default: the calendar's zone) or ISO with an offset; a date (`YYYY-MM-DD`)
makes an all-day event, whose `end` is its last day.

- `create_event` — `title`, `start`, optional `end` (default an hour later;
  all-day: the same day), `all_day`, `calendar` (default: Default),
  `description`, `location`, `tz`, `id` (your own id, retry-safe).
- `update_event` — `id`, `rev`, and any of the create fields. `start` alone
  moves the event and keeps its length; switching between timed and all-day
  needs a new `start`.
- `delete_event` — `id`, `rev`. Asks the user to confirm. It archives the
  event; `restore_event {id}` brings it back.

```json
{"op": "create_event", "title": "Design review", "start": "2026-10-20T14:00", "end": "2026-10-20T15:00", "calendar": "Work"}
{"op": "create_event", "title": "Offsite", "start": "2026-11-02", "end": "2026-11-04"}
{"op": "update_event", "id": "event-…", "rev": "2", "start": "2026-10-21T14:00"}
```

## Occurrences of a repeating row

`table`, `entry_id`, `field` and `rev` come from the row's query result;
`occurrence` is its `repeat.occurrence`. Each is one step in your undo
history (a person can undo it). A row that does not repeat has no
occurrences: change its date with `table {op: "write"}`.

- `complete_occurrence` — marks the row's current occurrence done and moves
  it to the next. `occurrence`, if given, must be the current one.
- `skip_occurrence` — the same, logged as skipped.
- `move_occurrence` — `move_to`: a new date (date field) or date-time (in
  the repeat's zone, or with an offset) for the current or an upcoming
  `occurrence` (default the current one).

```json
{"op": "complete_occurrence", "table": "chores", "entry_id": "…", "field": "due", "occurrence": "2026-10-15", "rev": "ab12cd34"}
{"op": "move_occurrence", "table": "chores", "entry_id": "…", "field": "due", "occurrence": "2026-10-18", "move_to": "2026-10-19", "rev": "ab12cd34"}
```

## Reminders

A sound and a banner at the start and/or before it. The item is one of: `id`
(an event), `table` + `entry_id` + `field` (a row's date field; only timed
rows fire), or `automation_id`.

- `get_reminders` — the item's settings, or `null`.
- `set_reminders` — `enabled`, `at_start`, `before` (e.g. `["15m", "2h",
"1d"]`, replaces the list), `sound` (`chime`, `bell`, `ping`, `pulse`,
  `marimba`, `none`). Fields left out keep their value (new items: on, at
  the start, no advance reminders, chime). `clear: true` removes them.

```json
{ "op": "set_reminders", "id": "event-…", "before": ["15m"] }
```

## Access

Table rows follow your `table` tool access. Without table read, `query`
leaves rows out (and says so in `hidden`), `list` leaves out the bound
fields, and reminders on a row are refused. The occurrence ops are table
writes and need table write. Only custom tables appear. Automation wakes and
`intervals` follow your `automation` tool access the same way: without its
`list`, `query` leaves them out (`hidden` says so) and reminders on an
automation are refused, get and set. Access rules may
name `calendar_read` (list, query, get_event, get_reminders) or
`calendar_write` (the other ops).

## Fields not listed in the schema

To keep every turn small, the advertised schema leaves out the rarer fields:
query's `tables`, `fields`, `repeats`, `status` and `project_id`;
create_calendar's `color`; `automation_id` (get_reminders and
set_reminders); and set_reminders' `enabled`, `at_start`, `before`, `sound`
and `clear`. They work exactly as described
above: pass them as normal fields. `tool({op: "schema", name: "calendar"})`
returns their full schemas as `unlisted_parameters`.
