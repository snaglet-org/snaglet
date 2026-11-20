# automation

Automate a message to a thread to wake yourself (people can also wake another
agent or thread). Use it for
work that should not be forgotten or left idle (check a process later, resume
a workflow, a standing reminder); it does not keep the model running between
wakes, it posts a message that wakes an idle agent. Agents schedule wakes for
themselves in the thread they are in. At each wake Snaglet posts
`[automation <name>] @You <prompt>` in the thread and wakes you, so write the
prompt as the instruction you want to read then. Rows live in the builtin
**Automations** table and show on the calendar.

- `create` — `{op: "create", name, prompt, when, calendar_id?}`. Returns the
  automation and echoes your `when`. Each automation carries `tz` (its zone),
  `next_run_at` (UTC, ISO) and `next_run_local` (the same moment in `tz`, e.g.
  `Tue, Oct 13, 1:50 PM PDT`); tell the user the local one.
  Example: `{op: "create", name: "Check export", prompt: "Check the export and report its result", when: {in: "30m"}}`. Disable an automation when its work is done.

- `list` — `{op: "list", status?, mine?}`. `status` is `active` (default),
  `paused`, `finished`, `cancelled` or `all`; `mine` (default true) lists only
  the ones that wake you.
- `get` — `{op: "get", id}`. Read-only full detail: `name`, `prompt`,
  `agent_id`/`agent_name`, target `thread_id`/`thread_title`, `when` (words),
  `schedule` (raw normalized timing, not a create/update `when` input), status,
  next run (UTC and local), `last_run` (result or null), calendar, ownership,
  timestamps and running state. Agents may read only automations that wake
  them (including ones a person created); people may read any. Available in
  automated runs too. A missing id uses the same not-found error as other ops;
  another agent's record is refused without returning its contents.
- `update` — `{op: "update", id, name?, prompt?, when?, calendar_id?}`.
  `calendar_id` is a calendar's id, or `null` for no calendar; left out,
  create uses the Default calendar and update keeps the current one (also
  when the timing changes).
- `disable`, `enable`, `cancel` — `{op, id}`. `disable` stops future wakes and
  keeps the automation; `enable` resumes them (`pause` and `resume` still work
  as older names). `cancel` keeps the automation's
  run history until a person deletes it from the Archive drawer; `enable` also
  undoes a cancel, bringing it back as it was (a paused one stays paused, one
  with no more runs comes back finished).
- `run` — `{op: "run", id}`. One wake now, to test an automation you created
  (paused and finished ones too). Returns `run.status` (`succeeded` = posted,
  `skipped`, `failed`) with any `error`, and a `note`. A wake in the thread you
  are in reaches you as a new message once your current run ends.
- `runs` — `{op: "runs", id, limit?, before?}`. The run log, newest first:
  `due_at` (UTC) and `due_local` (in the automation's `tz`), `status`
  (`succeeded`, `failed`, `skipped`, `running`), `error`, `manual` (a run now).
  `limit` 1–50 (default 10); pass `next_cursor` as `before` for older runs.

`when` is an object (not a JSON string) with exactly one of:

| shape                                                                  | meaning                                                                                                                                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{in: "30m" \| "2h" \| "1d"}`                                          | once, that long from now                                                                                                                                                      |
| `{at: "2026-10-14T09:00"}`                                             | once, at that local time                                                                                                                                                      |
| `{repeat: "FREQ=WEEKLY;BYDAY=MO", at: "09:00", starts?: "2026-10-14"}` | an RRULE (DAILY to YEARLY; COUNT or UNTIL allowed) at that time                                                                                                               |
| `{every: "15m" \| "2h" \| "1d"}`                                       | an interval, 15 minutes to 7 days; a line on the calendar                                                                                                                     |
| `{every: "15m", at: "2026-10-14T09:07"}`                               | an interval anchored at `at` (runs at :07, :22, :37, :52, so automations can share an interval staggered); a future `at` is the first run, a past one aligns to the next slot |
| `{every: "5m", window_start: "05:05", window_end: "06:00"}`            | an interval inside a daily window: 05:05, 05:10 … 06:00 each day, nothing outside it                                                                                          |
| `{first_open: true, after?: "05:00"}`                                  | once a day, the first time Snaglet is open and the computer awake at or after `after` (default 05:00); a day Snaglet is not open is skipped                                   |

`every` + `at` keeps its UTC phase across daylight-saving changes (a daily one shifts an hour on the wall clock); use `repeat` for wall-clock times.

A window (`window_start` and `window_end`, both `HH:mm` local times in `tz`)
keeps an `every` to that part of each day: the first run is at
`window_start`, then one each interval up to and including `window_end`, then
nothing until the next day's `window_start`. A window may cross midnight
(`"22:00"` to `"02:00"`). It cannot go with `at`, and `every` must then be
under `1d`. Agents' `every` is at least 15 minutes, or 5 minutes with a window
of at most 2 hours, so a short interval always stops each day.

`first_open` suits work that should start when the user sits down (a morning
briefing): it waits for Snaglet to be open instead of firing at a fixed time while
the computer sleeps. It has no fixed time, so its `next_run_local` reads
`when Snaglet first opens, from Wed, Oct 14, 5:00 AM PDT` (the earliest it may
run); tell the user that, not a time.

Add `tz` (an IANA zone) to any shape; the default is the user's zone. Times are
wall-clock, so "09:00" stays 09:00 across daylight-saving changes.

Rules:

- You can only schedule wakes for yourself, in your own thread, and change only
  automations you created (`You can only change automations you created.`).
- `every` under 15 minutes needs a window of at most 2 hours, and is at least
  5 minutes; the floor error says so and names `window_start` and
  `window_end`. An automation whose interval is under your floor (for example
  after its window was removed) can't be enabled until its `when` changes.
- At most 10 active automations per agent and 3 created per run.
- `run` works only on automations you created, at most 3 times an hour each.
- A run an automation started cannot create, change or run automations. Nobody
  is there to confirm a tool call, so a call that would ask is skipped with a
  tool error (`… needs a person to confirm; skipped (unattended run) …`) and
  the run carries on. A person can set the automation to run such a call
  instead when your tool access already allows it (`unattended_policy` on
  `get`: `skip` or `auto-approve-allowed`); a call your access rules would ask
  about is skipped either way. Your own `update` of an automation puts it back
  to `skip`, and a wake you start with `run` is always `skip`. `ask` fails at
  once in such a run (nobody is there to answer).
- A wake whose previous run is still going is skipped. Three failed wakes in a
  row pause the automation and notify the user.
- A wake missed while Snaglet was off runs once if it is at most an hour late;
  older ones are skipped (a missed one-off finishes and notifies). A
  `first_open` wake is never missed; a day Snaglet was not open is just skipped.
- A wake that fires within 3 minutes of Snaglet starting or the computer waking
  first waits (up to 2 minutes) for your provider's host to answer; if it
  never does, the run fails with `Network not ready: …` and nothing is
  posted.

People (the panel, the CLI) may also pass `thread_id` and `agent_id` on create
(unlisted parameters).

## Fields not listed in the schema

To keep every turn small, the advertised schema leaves out `calendar_id`
(create, update), list's `status` and `mine`, runs' `limit` and `before`, and
create's `thread_id` and `agent_id` (people only). They work exactly as
described above: pass them as normal fields.
`tool({op: "schema", name: "automation"})` returns their full schemas as
`unlisted_parameters`.
