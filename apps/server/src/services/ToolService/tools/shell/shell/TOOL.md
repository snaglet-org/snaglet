# Shell

Run shell commands on the host. One tool, two ops:

- `run` — execute `cmd` in `workdir` (defaults to the project folder). Returns when the
  command exits or after `yield_time_ms` (default 10 s); a still-running command returns a
  `session_id`. `timeout_ms` is the hard lifetime: default 5 min, max 30 min (the server can
  raise both, up to 4 h; a larger value is clamped and the result says so). The wait is never
  longer than the lifetime.
- `run` with `background: true` — for tests, builds and servers you'll check on later. Returns
  at once (after up to 1 s, so a command that fails straight away reports here) with its
  `session_id` and pid. The job's lifetime is `timeout_ms`, default and max 2 h. When it exits
  (or hits its limit) you get one message with the exit code, how long it ran and the end of
  its output: mid-run at your next tool step, or, if you are idle, it wakes you once. No need to
  poll; `write` still reads its output, until 10 min after it ended. At most 3 running at
  once; to stop one early, `kill -TERM -<pid>`. Stop does not kill background jobs (they are
  detached from the run); archiving or deleting the agent does, and so does a server restart
  (you are told on the next boot). Subagent helpers cannot start them.
- `write` — send `chars` to a running session's stdin, or omit `chars` to poll for new
  output. Repeated polls with no new output kill a stalled foreground session (background
  jobs are exempt).

Processes are pipe-backed, not a TTY: interactive prompts (`git add -p`, editors, pagers)
will hang. Use non-interactive flags.

The working tree is shared with people and other agents, so `run` (and each line typed with
`write`) refuses git commands that discard others' work or need a TTY: `stash`, `reset --hard`,
`clean -f`, `checkout -f` / `-- <path>`, `switch --discard-changes`, `restore` (without
`--staged`), `push --force` / `+refspec`, `branch -D`, and the interactive `add -p`,
`checkout -p`, `rebase -i` and `commit` without `-m` / `--no-edit`. The refusal names the
alternative.
It is a rail against mistakes, not a sandbox: it does not see through `sh -c` nested more
than one level or quote-split words like `git sta"sh"`. `run` refuses `chars`/`session_id`
and `write` refuses `cmd`, so each op only takes its own fields.

Tool-access rules apply to `write` too: every line it would submit (including text left
unfinished by earlier writes) is checked like a `run` command, so a denied command stays
denied when typed into a session, and under an allow list each typed line needs an allow
rule. A bare `write_stdin` or `shell` allow trusts all typed input; deny rules still apply.
A deny that names a command (`shell_exec(rm:*)`, `write_stdin(rm:*)`, …) applies to every
shell op, both `run` and `write`, because it is about the command. Bare denies and every
allow stay scoped to their own op.

A command deny rule is checked against every command a line would run (each part of a chain,
`$(…)`, `sh -c '…'`, a program given by path or after `sudo`), and a write is read as one
script. A rule needs all its flags: deny `rm -r:*`, not `rm -rf:*`. A command the rule
cannot check, such as one whose program is in a variable, is refused with the reason. If a
command is refused, do not rephrase it to get around the rule; ask the user. One exception: a
heredoc inside `$(…)`, backticks or `<(…)` is always refused, so give that text to the program
directly, as in `git commit -F - <<'EOF'` or `gh pr create --body-file - <<'EOF'`.

These ids work as aliases: `exec_command` → `run`, `shell_exec` → `run`
(`command` → `cmd`, `cwd` → `workdir`, and it still waits for the command to finish),
`write_stdin` → `write`.

## Direct commands vs. script orchestration

Normal tool calls are the default. Reach for **script orchestration** only when a workflow
benefits from batching, loops, transformation logic, or composing many Snaglet tool calls with
local code.

When shell access and the Snaglet CLI are available, scripts can live under `~/.snaglet/scripts` and
run with `snaglet run <script>`. Node scripts can `import { tools, snaglet } from '@snaglet/sdk'`; those
calls proxy through Snaglet's normal tool-execution layer, so they keep validation and safety
rails instead of bypassing the workspace. Use `--dry-run` first for destructive, large, or
uncertain scripts. Keep scripts scoped, inspectable, and disposable unless the user asked
for a reusable automation.
