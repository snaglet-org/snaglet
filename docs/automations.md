# Automations

An automation wakes an agent at set times with a prompt, in a thread you choose. The wake shows
in the thread as a message.

## The Automations view

- It lists automations and [scripts](./hooks.md) as sentences, such as "Every day at 9:00 AM →
  wake Clio in Plan my week", grouped **Active**, **Paused or off** and **Finished**.
- **Recent runs** shows what started each run, its result and how long it took.
- The activity bar icon spins while one is running.

## Creating one

Ask an agent ("check the inbox every weekday at 9"), or use **+ → New automation** and pick the
agent, thread, name, prompt, timing and calendar.

- **Once**: at a date and time.
- **Repeat**: every day, weekday, week on a day or month on a date, at a time. Or **When Snaglet
  first opens that day**, after an earliest time, while your computer is awake.
- **Every** few minutes or hours, from a first run or only between two times of day. Agents need
  at least 15 minutes, or 5 inside a window of up to 2 hours.

Agents create automations only for themselves, in their own thread, never from an automated run.
Snaglet notifies you when an agent schedules or changes a repeating one.

## Managing one

- Open one to **Pause / Resume**, **Run now**, **Edit** or **Archive** it, and to see its next
  run, run log and thread.
- Three failed wakes in a row pause it, and Snaglet tells you.
- It shows on the Default calendar unless you pick another or **No calendar**. While paused, it
  is off the calendar.
- If Snaglet was off, a wake up to an hour late runs once at startup. Older ones are skipped and
  logged. A missed **Once** notifies you.

## Runs with nobody watching

A run never waits for approval. **Tool calls that ask for a person**, in the **Edit** form:

- **Skip calls that ask** (default): skip the call and carry on.
- **Run calls tool access allows**: approve it if the agent's tool access allows it.

Deny rules still apply. Each skipped or approved call leaves an `[unattended]` line in the
thread. An agent's edit resets this to skip, and a run an agent starts always skips.

## How it's built

- `apps/server/src/services/automations/AutomationService.ts` is the only writer of
  `automations` and the `schedules` row each owns, in one transaction. `reconcile()` repairs
  drift at boot.
- `apps/server/src/services/ScheduleService.ts` claims due schedules, applies the missed-run rule
  and calls `AutomationService.fire`, which posts `[automation <name>] @Agent <prompt>` as the
  user and dispatches it like a user message. Runs are rows in `schedule_runs`.
- Timing rules and interval floors: `packages/shared/utils/automationTiming.ts`.
- Limits are `automations.*` settings
  (`apps/server/src/services/settings/categories/automations.ts`): active per agent (10),
  created per run (3), agent floor (15 minutes), missed-run grace (60 minutes), failures before
  pause (3) and agent **Run now** per hour (3).
- Unattended policy: `apps/server/src/services/SocketService/dispatch/unattendedWake.ts`.
  Notices: `apps/server/src/services/automations/automationNotices.ts`. Calendar placement:
  `apps/server/src/domains/calendar/automationOccurrences.ts`.
- Agents use the `automation` tool. UI: `apps/desktop-ui/src/features/automations/`. Routes:
  `apps/server/src/routes/automations.ts`.
- Tests: `tests/integration/apps/server/services/automations/`,
  `tests/unit/packages/shared/automationTiming.test.ts`.
- Overview: [Automations and hooks](./architecture.md#automations-and-hooks).

## Related

- [Hooks](./hooks.md)
- [Agents](./agents.md)
- [Threads](./threads.md)
- [Calendars](./calendars.md)
- [Tools](./tools.md)
