# hook

One tool, `op` = `create | run | update | enable | disable | run_as`. The sections below describe `create` unless stated.

## Ops

- `create` (`name`, `description`, `events` or `hook_source`): scaffold a new hook, registered disabled.
- `run` (`hook_id_or_name` + at most one mock entity id, or `payload`; `force`): run a saved hook on demand through the script page's test-console resolver. Pass one concrete mock entity (`message_id`, `thread_id`, `agent_id`, `run_id`, or `table_id` with `entry_id`); Snaglet builds the event payload from it. Table rows default to `table_entry:update`; `event_name` selects `table_entry:create`, `:delete` or `:occurrence`. Disabled hooks refuse unless `force: true`; unknown names fail with near-name suggestions. A run from hook code joins that hook's chain, so the chain limits below apply (`ok: false`, reason in `stderr`).
- `update` (`name`, `hook_source`): replace an existing hook's `hook.ts` and rebuild; a build error is returned. The enabled state is left as it was; the hook's unattended policy goes back to `skip` (`unattended_policy` in the result), and only a person can choose `auto-approve-allowed` again. A hook run you start with `run`, or that your own write or message fires, never auto-approves anything it wakes.
- `enable` / `disable` (`name`): set the activation state. Idempotent (`changed: false` when already in that state); never runs the hook or edits its code or triggers.
- `run_as` (`name`, `run_as`): set the agent the hook acts as, or `""` to clear it. You may name only yourself; see [Run as](#run-as).

Old ids `create_hook` and `run_hook` still resolve to `hook` with their op pinned.

### Asks first

`create`, `run`, `update`, `enable` and `run_as` all stage or execute code that runs as the user, so a guarded agent is asked to confirm before each of them. `disable` (turns a hook off) and read ops are not gated. A trusted / "all tools" agent skips every such prompt (see [Run as](#run-as) for how the hook's own run-time access is judged, which is separate from this call-time confirmation).

Creates `<snaglet-home>/hooks/<name>/hook.ts` atomically, then waits for the hook scanner to build and register it. The scanner owns building and registration; this tool only writes source and reports what the scanner concluded. When the build fails, the compiler error comes back in the tool result — fix `hook.ts` with `file(op:update)` and the watcher rebuilds it.

## Activation

The new hook is registered **disabled**. While disabled it never runs from a lifecycle event or a schedule, and a person turns it on with its switch in the Automations view, where hooks are listed as scripts (or `hook(op:enable)` where your access rules allow it). Call it a script when you talk to people: that is the interface's word for a hook. An explicit on-demand test run is still available through `hook(op:run)` (`force: true`). Write the description you return to the user accordingly — do not tell them a hook is "live" or "running" when it is disabled.

## What you are writing

`hook.ts` is the single source of truth for a hook's triggers, filter, and behavior. It is bundled with esbuild against a vendored `@snaglet/sdk` (no install step) and executed in a **crash-isolated child process** that is killed at roughly 30 seconds. Hooks are **observers**: fire-and-forget, no return value is consumed.

```ts
import { defineHook, snaglet } from '@snaglet/sdk';

export default defineHook({
  on: ['message:create'],
  filter: { threadId: 'thread-…' },
  async run(event) {
    // event is { type, ...payload }
    await snaglet.tools.execute('create_doc', { title: 'Note', content: event.type });
  },
});
```

Rules:

- The default export must be `defineHook({ … })`, and the definition must declare `on`, `schedule`, or both — a definition with neither is rejected at registration.
- `filter` is a strict-equality partial match against the event payload, evaluated server-side **before** the child process is spawned. Prefer it over an early `return` in `run`.
- Act on the workspace through `snaglet.tools.execute(name, input)`, which resolves to `{ success, output, error?, durationMs }` where `output` is a plain string. Tool ids are snake_case and parameter names are exact.
- Read a Database table with `snaglet.tables.read(input)` when code needs the values: it takes a `table` read's input and resolves to `{ rows, fields, text }` (shape below), or throws when the read fails.
- Import only from `@snaglet/sdk` and `node:*`. Third-party packages need an install step that is not part of the build.
- Keep `run` fast and idempotent; the same event can legitimately arrive more than once.

`schedule` accepts `{ at: ISO }`, `{ every: n, unit: 'minute' | 'hour' | 'day' | 'week', anchor? }`, or `{ time: 'HH:MM', timezone, weekdays? }`.

## Structured table reads

`snaglet.tables.read(input)` runs `table` with `op: "read"` and returns:

```ts
{
  rows: Record<string, string | number | boolean | null | (string | number | boolean | null)[]>[];
  fields: string[]; // row keys in order
  text: string;     // exactly what snaglet.tools.execute('table', { op: 'read', ... }).output returns
}
```

- `{ sql }`: one row per result row, keyed by column. A numeric column is a `number`, a boolean a `boolean`, an array column a list, a NULL `null`; text, select labels, dates, timestamps and ranges are the string the TSV shows. A cell cut by `max_cell` stays text.
- `{ table, ids }` and `{ table, where?, sort?, columns?, page? }`: `id`, `rev` (the short revision a guarded `table` write takes), then every field by name, `null` when the row has no value. A number field is a `number`, a checkbox a `boolean`, a select its label, a multi-select or multiple relation a list.
- A number too large to keep exactly (beyond 2^53, such as a bigint id) stays the string the text shows; other numbers are JavaScript numbers (about 15 significant digits).
- `{ table }` and `{}` (field list, table list) have no rows: `rows` and `fields` are empty and `text` carries the answer.

`text` keeps the old format, so a hook that parses `output` keeps working. Gate on a phase without parsing:

```ts
const { rows } = await snaglet.tables.read({
  sql: 'SELECT status FROM user_tables.work_loop WHERE phase = 2',
});
if (rows.length > 0 && rows.every((row) => row.status === 'Done')) {
  // every row of phase 2 is done
}
```

## Run as

A hook runs as the agent whose event it observes (a `run:end`, an agent's `message:create`), else as the system actor (ghost), whose access is limited to `table`, `thread` send/read and `database_query`. A hook can be set to **run as** one agent instead, in the hook editor (Runs as) or with `hook(op: run_as)`:

- Its tool calls are judged by that agent's own tool access, never wider. A call the access rules would ask about is refused, and a call to a tool or op set to ask first for that agent (a guarded agent's `hook` update/enable, an "ask first" override on the agent or on the hook run's thread) is skipped with a tool error (nobody can answer); the hook carries on. Every hook run skips such calls, with or without run as.
- What it posts with `thread` op `send` is sent as that agent and ends with the line `[hook <name> as <Agent>]`; the agent itself is not woken by its own message. Rows it writes go into that agent's table history. Only run as attributes writes to an agent: a hook without it keeps the attribution it had.
- `snaglet.context.get().agentId` is that agent, and the Runs tab shows `as <Agent>` on each run.
- It covers the code that was built when it was set. New code (`hook(op: update)`, a file edit, the builder, an imported file or the bundled SDK changing the build) clears it, and a run whose built bundle no longer matches is refused (checked as the run starts, which then starts a private copy of the bytes it checked); a person sets it again for the new code. The hook needs a ready build to take one.
- The agent must exist, be active (not archived) and be a top-level agent (not a subagent helper); ghost is refused, since clearing the setting already means the system actor. The check runs when the setting is saved and again before every run: a run whose agent was archived after it was picked is refused and recorded as a failed run, never run as someone else. Deleting the agent clears it.
- Events and schedules of an enabled hook run as the agent. An on-demand run (`hook(op: run)`, `snaglet.hooks.run`, the test console) does only for a person or that agent itself, and only on an enabled hook; any other agent runs the hook as itself. `snaglet.hooks.run` from a custom tool a person runs or tests comes from ghost, so run as does not apply.

Who may set it: a person in the hook editor, any active agent. An agent with `hook(op: run_as)`, only itself, and it may clear (`""`) only a run as that names itself. Hook code can never change it.

## Loops and the remaining guards

A hook's work can trigger other hooks: a tool call that edits a row fires `table_entry:update`, `snaglet.emit` fires `hook:signal`, a finished run fires `hook:finished`, and `snaglet.hooks.run` runs a hook directly. **Snaglet does not refuse loops.** If you want a hook to run on every edit, it runs on every edit — a loop you want ends on its own, through the hook's own conditions (prefer `status changed to In review` over `status is In review`). Chain depth and the chain of hook names are recorded on every run so you can see what happened, but they never refuse a run.

Only two guards remain, and neither is about edit-driven loops:

- **Runs per minute (burst cap):** one hook may run automatically at most `workers.hooks_max_runs_per_minute` times in any minute (default 600, 1–10000). Schedules and runs a person starts don't count. This is a last-resort rate cap against a tight runaway, not a loop detector.
- **Nested self-run:** `snaglet.hooks.run` / `hook(op:run)` never waits for a free slot (that could deadlock the hooks waiting on it), and a hook can't run **itself** synchronously this way while it is still running — that is unbounded recursion inside one run, not an edit loop, so it is refused. When every slot is busy a nested run is also refused; `snaglet.hooks.run` returns it with `result.ok === false` and the reason in `result.stderr`.

The chain still carries through agent turns the hook starts. When a hook sends a message that wakes an agent (`thread` with `op: "send"`), that agent's turn runs in the hook's chain, so anything the agent writes is recorded as caused by the hook — and if that write fires the same hook again, it runs. Make sure the hook stops on its own (with a `filter`, or by checking the event) so a wanted loop actually ends.

`repeatInChain` in `defineHook` is **deprecated and a no-op** — repeats are not refused, so there is nothing to opt out of. It is still accepted so existing hooks keep loading.

## Parameters

`events` names the lifecycle events the generated scaffold observes; the enum in the parameter schema is the authoritative list, taken from the SDK the hook is compiled against. `hook_source`, when supplied, is the complete contents of `hook.ts` and declares its own triggers, so `events` is ignored. Without `hook_source` the generated hook compiles and only logs — replace `run` with real behavior.

### Fields not listed in the schema

To keep every turn small, `run`'s mock-event fields (`event_name`,
`message_id`, `thread_id`, `table_id`, `entry_id`, `agent_id`, `run_id`,
`payload`) and `force` are left out of the advertised schema. They work
exactly as described under Ops: pass them as normal fields.
`tool({op: "schema", name: "hook"})` returns their full schemas as
`unlisted_parameters`.

## Creating only

`create` never replaces an existing hook; an existing name is always an error. That is a safety property, not a limitation: registration preserves a hook's enabled state across edits, so writing new code into a folder someone had already enabled would put that code on the live event bus immediately. To change an existing hook, use `hook(op:update)` or edit its `hook.ts` with `file_edit` — the human's enablement decision then stays attached to code they chose to keep. To build something different, pick another name.
