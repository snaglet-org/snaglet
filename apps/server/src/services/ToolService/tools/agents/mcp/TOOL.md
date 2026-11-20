# mcp

MCP servers; the verb is `op`. Same rules as Settings → MCP
(`/api/mcp/servers`), through the same code.

| op               | What it does                                                     | Fields                                                                                             |
| ---------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `list`           | Every server: config, live status, whether a credential is saved | —                                                                                                  |
| `get`            | One server                                                       | `id`                                                                                               |
| `create`         | Add a server                                                     | `id`, `name`, then `command` (+`command_args`, `env`) for stdio or `url` (+`headers`) for http/sse |
| `update`         | Edit a server; only the fields you pass change                   | `id` + any create field                                                                            |
| `delete`         | Remove a server and take it off every agent that uses it         | `id`                                                                                               |
| `restore`        | Undo your own `delete` within 10 minutes                         | `id`                                                                                               |
| `test`           | One-shot connection check: connects, counts tools, disconnects   | `id`                                                                                               |
| `set_credential` | Save the server's credential and reconnect                       | `id` + `secret` and/or `bundle`                                                                    |

The advertised schema leaves out, to keep every turn small, create and
update's `scope` (`shared`, the default: one connection for all agents, or
`per-agent`), `enabled` (default true), `autoload` (load its tools without a
search), `requires_confirmation` (ask before each of its tool calls, default
true) and `provider_id` (advanced: the provider whose credential it uses), and
set_credential's `bundle` (named fields, each read by `${cred.<field>}`). Pass
them as normal fields. `tool({op: "schema", name: "mcp"})` returns their full
schemas as `unlisted_parameters`.

## Rules

- `create` refuses an id that already exists (use `update`) and an id that
  matches a model provider's credential namespace (e.g. `openai`).
- `update` keeps `enabled`, `autoload` and `provider_id` unless you send them,
  and a builtin server stays builtin.
- `restore` puts back the exact server you deleted, with its env, headers and
  saved credential, and turns it back on for the agents that had it. It only
  needs the `id`. It works for 10 minutes after the delete and not after Snaglet
  restarts, fails if a new server has taken the id, and refuses a server
  another agent or a person deleted.
- Changes take effect right away; tools appear as `mcp__<id>__<tool>`.
- `create`, `update`, `delete` and `set_credential` ask for confirmation by
  default: they can launch a command, call a URL, remove a server from agents,
  or store a secret.

## Secrets

Never put a literal secret in `env` or `headers`. Use a placeholder:

- `${credential}` reads the opaque `secret`.
- `${cred.<field>}` reads one field of the `bundle`.

Then save the value with `set_credential`, or ask a person to add it in
Settings → MCP. `list` and `get` mask literal env/header values as `•••`, and
no op ever returns a saved credential. A secret passed to `set_credential` is
still recorded in this run's transcript like any tool input, so prefer the
Settings screen when a person is available.
