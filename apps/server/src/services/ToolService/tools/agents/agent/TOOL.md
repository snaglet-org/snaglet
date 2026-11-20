# agent

One tool for Snaglet agents; the verb is `op`.

| op         | What it does                                                                   | Key fields                                                                                                        |
| ---------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `create`   | Create an agent; it is available immediately                                   | `name`, `role` (both required), `system_prompt`, `identity`, `provider`, `model_id`, `tool_access_mode`, `skills` |
| `get`      | One full record, including the complete system prompt and identity             | `agent` (id or name); `view: "runtime_self"` for your own runtime                                                 |
| `list`     | The roster: id, name, role, model, provider                                    | `include_archived`                                                                                                |
| `update`   | Change any subset of fields; only the fields you pass change                   | `agent_id`, plus any create field; `add_skills` / `remove_skills` / `set_skills`                                  |
| `archive`  | Hide an agent from rosters and pickers; history, memories and threads are kept | `agent_id`                                                                                                        |
| `restore`  | Undo an archive                                                                | `agent_id`                                                                                                        |
| `abort`    | Stop your own active run in a thread without stopping other agents             | `thread_id`, `agent_id` (your own id)                                                                             |
| `activity` | Another agent's recent activity, or your own                                   | `view: "agent"` + `agent_name`, `"self_recent"`, or `"self_history"`                                              |

## Notes

- `update` with `scope: "self"` edits only your own name, role, identity and
  system prompt; it refuses skill and other changes.
- `system_prompt` is shipped verbatim: it must be self-contained. Mirror an
  identity doc into it when the agent has one.
- Skills are referenced by id or slug. A slug shared by a personal and a
  project skill must be passed by id. An unknown skill fails the whole call
  before anything is written. Assigning a skill grants no permissions; it only
  lists the playbook in the agent's `## Skills`.
- `archive` refuses the ghost system agent and the calling agent itself. There
  is no hard delete here; that stays a user action in the app.
- Your own turns in the current thread are already in your context; use the
  `activity` self views only for other threads or runs aged out of context.

## Fields not listed in the schema

To keep every turn small, the advertised schema leaves out `scope`,
`tool_access_mode`, `add_skills`, `remove_skills`, `set_skills` and
`include_archived` (see the table and notes above) and the `activity`
filters. Pass them as normal fields; `tool({op: "schema", name: "agent"})`
returns their full schemas as `unlisted_parameters`. The `activity` filters:

- `run_id`: one run's entries; `last_n_runs`: the last N runs; `limit`: at
  most this many entries; `before`: the page before this cursor.
- `action_type` (`tool_call` or `thinking`) and `tool` (a tool name; legacy
  names match too) keep only those entries.
- `include_input_preview` (view `agent`): a preview of each tool input.
- `include_outputs` (default true) and `output_max_length` (100-10000,
  default 2000; view `self_history`): the tool outputs and how much of each.
- `all_threads` is accepted for older callers and changes nothing: pass
  `thread_id: null` to read every thread (the default is the current one).

Old tool names still work and each one maps to exactly one op: `create_agent`
→ create, `get_agent` → get, `update_agent` → update, `abort_agent_run` →
abort, `agent_activity` → activity.
