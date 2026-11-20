---
name: snaglet-sdk
description: Load when you are repeating the same tool calls or a complex operation will recur, and condense it into a script, custom tool, hook or automation; one run replaces many turns of repeated calls and keeps bulk data out of your context, so the mechanical part moves to code and the decisions stay with you or the user. Not for small one-off edits or steps that need judgment.
---

# Condense recurring Snaglet work

Typical signs: the same calls over dozens of rows or docs, a loop over search results, a transform you will run again.

## Pick the form

- **Script** (`snaglet run`, run from `shell`): a bulk job now, once or on demand. See Scripts.
- **Custom tool** (`custom_tool` op `create`): a routine agents will call again, as one typed operation; make one once a script has proven the job recurs. See Custom tools.
- **Hook** (`hook` op `create`, in `~/.snaglet/hooks/`): something that should happen when an event occurs, such as a message or a row edit. See Hooks.
- **Automation** (`automation` op `create`): something that should happen on a schedule or at a set time; it wakes an agent with a prompt, so that step keeps its judgment. For code on a schedule with no agent, give a hook a `schedule`.
- **Skill**: a procedure that needs judgment, not code.

## Scripts: `snaglet run`

- Create with `snaglet create-script <name>.mjs` (or `.ts`, `.py`). Scripts live in `~/.snaglet/scripts/` (or `$SNAGLET_HOME/scripts`); that folder does not exist until it is created by `snaglet create-script`, so a missing folder is not a fault. Run with `snaglet run <name> [args] [--dry-run] [--verbose]`. In a dev checkout the CLI is `node_modules/.bin/snaglet`.
- Node: `import { tools, snaglet } from '@snaglet/sdk'`. Every Snaglet tool is a method named by its tool id, with the same input as the tool call: `await tools.doc({ op: 'get', id })`. JSON output comes back parsed. A failed call throws.
- Python: `from snaglet_sdk import tools`.
- `snaglet.args` holds the command-line args. `--dry-run` prints every call instead of running it; use `tools.$real.x()` / `tools.$dry.x()` to force one call either way.
- Calls go through the server's tool layer (validation, permissions), never raw SQL. Fetch a tool's live schema with `tool` op `schema` before you script against it; don't guess parameter names.
- Many tools return text, not JSON: `table` `query` gives TSV, and `read` with `ids` gives `<id> (rev <rev>) {json}` lines. Under `--dry-run` a call returns `{ dryRun: true }`, not data, so do reads through `tools.$real`.

### Example: a bulk table fix

`~/.snaglet/scripts/trim-notes.mjs`. Run it as `snaglet run trim-notes misspellings --dry-run`, then without the flag.

```js
// snaglet run trim-notes <table> [--dry-run]: trim whitespace in every row's notes.
import { tools, snaglet } from '@snaglet/sdk';

const table = snaglet.args.find((a) => !a.startsWith('--'));
if (!table) throw new Error('usage: snaglet run trim-notes <table> [--dry-run]');

// Reads always run for real, so --dry-run still plans against live data.
const tsv = await tools.$real.table({
  op: 'query',
  sql: `SELECT id FROM user_tables.${table} WHERE notes <> btrim(notes)`,
  limit: 200,
});
const ids = tsv
  .split('\n')
  .map((l) => l.split('\t')[0])
  .filter((v) => /^[0-9a-f-]{36}$/.test(v));

// op:read with ids returns "<id> (rev <rev>) {json}" lines: the rev is the write guard.
const updates = [];
for (let i = 0; i < ids.length; i += 50) {
  const text = await tools.$real.table({ op: 'read', table, ids: ids.slice(i, i + 50) });
  for (const m of text.matchAll(/^(\S+) \(rev (\S+)\) (\{.*\})$/gm)) {
    const notes = JSON.parse(m[3]).notes;
    if (notes && notes !== notes.trim())
      updates.push({ id: m[1], rev: m[2], values: { notes: notes.trim() } });
  }
}

// One atomic write per batch; a rerun skips rows already fixed (the WHERE no longer matches).
for (let i = 0; i < updates.length; i += 50) {
  await tools.table({ op: 'write', table, update: updates.slice(i, i + 50) });
}
console.log(
  `${snaglet.dryRun ? 'would update' : 'updated'} ${updates.length} of ${ids.length} matched rows`
);
```

It reads only what it needs, writes 50 rows per atomic call with each row's `rev` as the guard, can be re-run safely, and prints one summary line.

## Custom tools

Create with `custom_tool` op `create` (`name`, `description`, `parameters_schema`, `handler_source`). The handler default-exports `async (input, context)`, imports only `@snaglet/sdk` and `node:*`, and calls Snaglet with `snaglet.tools.execute(name, input)`, which returns `{ success, output, error? }` with `output` as a string. Nested calls run under the calling agent's tool access, or ghost's allow list when a person runs the tool or tests it. Read `custom_tool`'s TOOL.md for the full contract.

### Example: `count_rows`

```ts
import snaglet from '@snaglet/sdk';

export default async function handler(input: Record<string, unknown>) {
  const table = String(input.table ?? '');
  if (!/^[a-z0-9_]+$/.test(table)) throw new Error('table must be a snake_case table name');
  const r = await snaglet.tools.execute('table', {
    op: 'query',
    sql: `SELECT count(*) AS n FROM user_tables.${table}`,
  });
  if (!r.success) throw new Error(r.error ?? 'query failed');
  return { table, rows: Number(r.output.split('\n')[1]) };
}
```

Its `parameters_schema` is `{ "type": "object", "properties": { "table": { "type": "string" } }, "required": ["table"] }`. It checks the input (a model wrote it), checks `success`, parses the string `output`, and returns a small JSON result.

## Hooks

A hook runs in the background in its own process, on an event or a schedule, so a failure never blocks a message. It is `~/.snaglet/hooks/<name>/hook.ts`, which default-exports `defineHook({ on?, schedule?, filter?, run })`.

Create one with the `hook` tool, op `create` (`name`, `description`, and `events` or a full `hook_source`). It writes the file, waits for the build, and the hook is registered **disabled**. A disabled hook never runs from an event or a schedule: a person turns it on with its switch in the Automations view, where hooks are listed as scripts. Never claim a hook runs automatically until it is enabled and you have seen it fire. `create` never replaces an existing hook; change one with op `update`.

Test it with the `hook` tool, op `run` (or `snaglet.hooks.run(name, { nodeIds })` from a script). A run makes real changes, not a simulation, so use a harmless fixture, and a disabled hook needs `force: true` to run.

```ts
import { defineHook, snaglet } from '@snaglet/sdk';

export default defineHook({
  on: 'message:create',
  filter: { role: 'agent' },
  async run(event) {
    await snaglet.log.info(`agent message ${event.id}`);
  },
});
```

Use `schedule: [{ every: 1, unit: 'hour' }]` or `[{ time: '09:00', timezone: 'America/Los_Angeles', weekdays: [1,2,3,4,5] }]` for timed runs.

### Avoid feedback loops

- A hook's own output can fire it again (a message it posts, a row it edits). Filter on the field that changed or on who made the change, and skip events the hook caused.
- Make each run safe to repeat: check whether the result already exists before writing, and never let one event start several more.
- A scheduled scan takes a bounded batch and keeps a cursor, so overlapping runs don't duplicate effects.

## Do it safely

1. Write down the contract first: inputs, which rows or docs it may touch, what it changes, and how you'll check it.
2. Run with `--dry-run` on a small slice and read the planned calls.
3. Run for real on the slice and read back the actual rows or docs; only then run the full set.
4. Make writes safe to retry: use the `rev` you just read as the guard and skip items already done, so a rerun after a partial failure doesn't duplicate work.
5. Print a short summary (counts, ids changed, failures), not bulk data.
6. Save a script worth keeping and say where it lives.
