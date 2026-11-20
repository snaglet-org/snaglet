# subagent

Named helpers for self-contained tasks; the verb is `op`. A helper runs in its
own hidden thread on a model you pick from your own provider, while you keep
working. Its report comes back to you on its own.

| op       | What it does                                                          | Key fields                                                   |
| -------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `start`  | Start a helper; returns at once                                       | `name`, `model`, `brief` (required); `tools`, `instructions` |
| `send`   | More work, the answer to its question, a redirect or a retry          | `name`, `message`                                            |
| `wait`   | Block until helpers finish, fail or stop (up to 240 s); their reports | `names` (default: your running helpers), `timeout_seconds`   |
| `stop`   | Pause a helper: its run stops, it keeps its work                      | `name`                                                       |
| `pause`  | Pause it, and resume it on its own later                              | `name`; `for` (`"15m"`) or `until` (ISO time)                |
| `update` | Replace its standing instructions (from its next turn)                | `name`, `instructions` (`""` clears)                         |
| `remove` | Stop it and delete it with its thread                                 | `name`                                                       |
| `list`   | Your live helpers in this thread: model, status, number of tasks      | none                                                         |
| `models` | The models your helpers can run on (your provider): ids, tags, yours  | none                                                         |

`pause`'s `for` and `until` are left out of the advertised schema to keep
every turn small; pass them as normal fields.
`tool({op: "schema", name: "subagent"})` returns their full schemas as
`unlisted_parameters`.

## How a helper reports

When a helper's thread goes quiet, Snaglet posts its last reply to you as a
separate message: the report, or a question for you. If you are still working
it lands at your next tool call; otherwise it wakes you. Only you see the
report; the user sees one line in the thread and can open the helper's thread
from the composer.

Never write or guess a report yourself. If you need the reports in this turn,
call `wait` after starting the helpers; it returns their real reports. If you
end your turn instead, each report arrives later and wakes you.

## When a helper fails

A failure reaches you the same way as a report, once: which helper (its name
and id), why it failed in plain words, and the work it had done so far. That
covers a model or provider error, a missing credential, the turn time limit,
the watchdog, a turn that could not start, and a server restart (that one
leaves it paused). `wait` returns it too.

A failed or paused helper is kept with its thread, brief and work so far. To
retry, `send` it what to do (for example "Try again from where you stopped").
To take over, do the task yourself and `remove` it. It is removed after a day
without work.

## Lifecycle

- A helper you do not give another task (`op: send`) during the turn that reads
  its report is removed when that turn ends: its thread and messages are
  deleted. Its usage stays in run history. A failed or paused helper is kept.
- Starting several helpers in one turn runs them in parallel. There is no limit.
- The user can open a helper's thread and talk to it while it runs, and pause,
  resume or remove it. You get a short notice when they do; it never wakes you.

## Writing the brief

The helper starts with no context but the brief and your project folder. Say
what to do, what you already know, the constraints, and exactly what the report
must contain (ids, paths, links). Helpers cannot ask the user, write memory or
start helpers. If one is stuck it ends with a question; answer with `send`.

## Instructions and tools

`instructions` (optional, up to 8000 characters) are standing rules for all
of a helper's work, added to its system prompt: a style, a format, what to
avoid. The brief is its first task; `send` gives it more. Change them with
`update`; the user can see and edit them in the helper thread's settings.

A helper has your tools, MCP servers and permissions, never more. `tools`
limits it to the ids you list (MCP tools by their full `mcp__server__tool`
id); without it, it has all of yours.

## Picking the model

Use a small fast model for lookups and summaries, and a strong one for writing,
code or judgment. The model must be an active, tool-capable model on your own
provider; call `models` to see them, and an unknown one is refused with the same list.

## Example

```json
{
  "op": "start",
  "name": "Scout",
  "model": "<a fast model id>",
  "brief": "Find 5 Toledo plumbers with weak websites. For each: name, URL, one-line reason. Report as a table."
}
```
