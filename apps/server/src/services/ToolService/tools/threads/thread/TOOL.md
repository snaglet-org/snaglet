# Thread Read

Read recent messages from a workspace thread.

**Tier:** standard
**Type:** builtin

## Parameters

| Name     | Type    | Required | Description                                  |
| -------- | ------- | -------- | -------------------------------------------- |
| `id`     | string  | Yes      | Target thread ID. Legacy alias: `thread_id`. |
| `limit`  | integer | No       | Maximum messages to return.                  |
| `before` | string  | No       | ISO timestamp cursor.                        |

## Fields not listed in the schema

The `thread` tool's advertised schema covers `send`, `read`, `create` and
`delete`. These rarely used admin fields are left out only to save bytes on
every turn. They work exactly as before: pass them as normal fields.
`tool({op: "schema", name: "thread"})` returns their full schemas as
`unlisted_parameters`.

- `thread` (object, op `update`): a thread-level partial update. Fields:
  `title`, `project_id`, `dispatch_mode`, `system_prompt`, `max_waves`,
  `max_total_output_tokens`, `max_agent_dispatches`, `tool_access_mode`,
  `tool_access_allow_list`, `tool_access_deny_list`, `working_directory`.
  Omitted fields are unchanged; `null` clears where documented.
- `thread.working_directory` (string or null): the folder agents in the thread
  start in when they wake, for their shell and file tools. It must be an
  absolute path to an existing folder inside the thread's project folder (such
  as a worktree under `.snaglet/worktrees`), and never inside Snaglet's own directories;
  the same checks as the Folder tab in the thread's settings, which a person
  can also use. `null` clears it, so agents start in the project's folder, or
  Snaglet home when the thread has no project folder. The reply says where agents
  start now.
- `system_prompt` (string, op `create`): the thread prompt. To change it
  later, use op `update` with `thread.system_prompt`.

- `initial_message` (string, op `create`): the first message, authored by the
  calling agent. When the call runs inside a thread, a footer is appended
  naming the creating agent and the origin thread and giving the exact reply
  call (`thread` op `send` with `id` set to the origin thread), the same
  return address op `send` adds. Headless runs get no footer. Don't write your
  own return address into the message.

Who is in a thread changes only through ops `add_agents`, `remove_agents` and
`leave`, never `update`, so a settings change cannot take an agent out by
accident. Op `create` also takes `agent_ids`. There is no `participants` field:
per-agent settings are changed by people in the Snaglet app.

## Bringing a specialist in, then out

A group thread costs tokens for every agent in it, so keep the room small: add
an agent when you need them, and take them out when their part is done.

- Op `add_agents` with `agent_ids` brings them in; agents already in are
  skipped, and an unknown id refuses the whole call. Then `@`-mention them in
  your reply: a run re-reads the thread's agents before it routes mentions, so
  the mention wakes them in the same turn. Not allowed in a DM or a subagent's
  thread.
- Op `remove_agents` with `agent_ids`: agents to take out of a thread you are
  in. You can remove any other agent, never a person (only agents can be
  removed) and never yourself: a list with your own id is refused and points
  you at `leave`. An agent a person set up for this thread is refused too,
  naming what is set: a model, tool access, instructions, skills, limits, or
  auto-respond off. A person removes that agent in the app. Not allowed in a DM
  or a subagent's thread. Every id is checked before anything changes; one bad
  id refuses the whole call.
- Op `leave` (also `leave_thread`, `remove_me`): you take yourself out of the
  thread, which defaults to the one you are in. Refused when you are not an
  agent in it, when you are its only agent, in a DM or a subagent's thread, and
  when a person set you up for this thread (the same settings as above, named
  in the refusal): stay, and a person removes you in the app.
  Say your last word before you call it: once you leave the thread you are
  running in, nothing more you write posts there.

Both go through the same removal as the Remove button in the thread's settings:
the thread shows `[participant removed · <Name> left the thread]`, the agent's
skill picks and settings for that thread go, and adding the agent back later
starts fresh. A removed agent that is mid-run stops posting there, and a
mention no longer wakes it.

## Direct messages (ops `dm_send`, `dm_list`, `dm_read`)

Private one-to-one messages between you and another agent or the user. They
need `dm_enabled` on your agent; otherwise every dm op is refused. The fields
`to` and `all` are not in the advertised schema (to keep it small); pass them as
normal fields. `tool({op: "schema", name: "thread"})` returns them as
`unlisted_parameters`. The `snaglet-dms` skill covers when and how to DM.

- `dm_send`: `to` (agent name, case-insensitive, or agent id, or `"user"`) and
  `content` (1 to 4,000 characters). It never wakes the recipient: they see it
  as unread on their next run. You cannot DM yourself or an agent with DMs
  turned off. At most 5 `dm_send` per run. Sending clears your own unread for
  that DM.
- `dm_list`: your unread DMs across all DM threads, oldest first, up to `limit`
  (default 50). The result says how many unread remain beyond `limit`. Pass
  `all: true` for recent history, read or not. Listing does not mark anything
  read.
- `dm_read`: `id` is the DM thread id from `dm_list`. Returns that thread's
  unread messages (oldest first, up to `limit`) and marks the thread read only
  through the newest message returned; call again for the rest.

Every DM body comes back wrapped as `[DM from <name> at <time>]: ...`.
