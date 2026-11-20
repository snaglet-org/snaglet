# Hooks

A hook is your own TypeScript script that runs when something changes in Snaglet, such as a table
row, a message or a finished run, or on its own schedule. The app calls hooks scripts.

## Using it

The **Automations** view lists scripts beside [automations](./automations.md), as sentences such
as "When a table row is created or changed → run notify-on-done".

- **+ → New script** opens a script page with **Code**, **Runs** and **Schedules** tabs.
- New scripts start off. **Enable** on the page, or the switch on the row, turns automatic runs
  on or off. A script that is off still runs from the test console.
- **Build failed** on a row means the code doesn't compile. Hover for the error.
- The trash icon moves the script's folder to the system Trash after asking.
- **Disable scripts**, under **Workers** in the status bar, stops all automatic script runs.

### Runs as

A script acts as the agent whose event it observes, else as a system actor limited to `table`,
thread send and read, and `database_query`. **Runs as** on the script page picks one agent
instead: the script gets that agent's tool access, never wider, and its writes are attributed to
it. New code clears the choice.

### Nobody watching

**Tool calls that ask for a person**, next to **Enable**, sets what an agent run this script wakes
does with a call that would ask: **Skip calls that ask** (default) or **Run calls tool access
allows**. With several scripts in a chain, the strictest wins. New code resets it to skip. The
script's own tool calls never wait: one that would ask fails.

## Writing a script

A script is `~/.snaglet/hooks/<name>/hook.ts`, and the folder name is its name. Saving rebuilds
it. Removing or renaming the folder unregisters it.

```ts
import { defineHook, snaglet } from '@snaglet/sdk';

export default defineHook({
  on: 'message:create',
  filter: { role: 'agent' },
  async run(event) {
    await snaglet.log.info(`Agent message in ${event.threadId}`);
  },
});
```

- Declare `on`, `schedule` or both. `schedule` takes `{ at }`, `{ every, unit }` or
  `{ time, timezone, weekdays? }`. `filter` matches payload fields exactly, before the run starts.
- Use `snaglet.tools.execute(name, input)` and `snaglet.tables.read(input)`. Import only
  `@snaglet/sdk` and `node:*`.
- A run is killed after about 30 seconds. An event can arrive twice, so keep `run` fast and safe
  to repeat.
- Events: `message:create`, `thread:create`, `thread:move`, `run:end`, `table_entry:create`,
  `:update`, `:delete` and `:occurrence`, `agent:create`, `:update` and `:delete`, `doc:create`,
  `:edit`, `:move` and `:rename`, `container:create`, `:move` and `:update`, `node:archive`,
  `node:restore` and `schedule:fire`.
- Snaglet doesn't stop loops. End one with the script's own conditions: act when a status changes
  to Done, not whenever it is Done. A script runs automatically at most 600 times a minute by
  default, and can't run itself with `snaglet.hooks.run` while it is running.
- Agents write scripts with the `hook` tool. Its `TOOL.md` is the full authoring guide.

## How it's built

Server paths are relative to `apps/server/src/services/`.

- `customHooks/HookRegistryService.ts` scans `~/.snaglet/hooks/`. It builds each folder with
  esbuild against a vendored `@snaglet/sdk` (`customHooks/buildHookBundle.ts`) into
  `~/.snaglet/build/hooks/`, reads its triggers, subscribes its events and writes its schedules to
  `schedules`. State is in `hook_registrations`. An edit keeps the enabled flag; new code clears
  run-as and the unattended choice.
- `HookService.ts` is the event bus. Hooks are observers: dispatch never blocks the emitter.
- `customHooks/hookRunner.ts` runs each hook as a crash-isolated child process with a timeout and
  a concurrency cap. Each run is a row in `hook_runs`. Guards: `customHooks/hookChainGuard.ts`
  (cap: `workers.hooks_max_runs_per_minute`). Runs as: `customHooks/hookRunAs.ts`.
- `ScheduleService.ts` fires hook schedules.
- Event types: `packages/snaglet-sdk/src/index.ts`, kept in lockstep with the build's copy in
  `ToolService/customTools/vendorSdk.ts`.
- The system actor's allow list is `GHOST_TOOL_ACCESS` in `ToolService/lib/agentToolPolicy.ts`.
  A hook that needs more adds it there in review.
- Script page: `apps/desktop-ui/src/components/HookBuilderPanel/` and
  `apps/server/src/routes/hooks.ts`.
- Tests: `tests/unit/apps/server/services/customHooks/` and
  `tests/unit/apps/server/services/HookService.test.ts`.
- Overview: [Automations and hooks](./architecture.md#automations-and-hooks).

## Related

- [Automations](./automations.md)
- [Tools](./tools.md)
- [Tables](./tables.md)
- [Agents](./agents.md)
