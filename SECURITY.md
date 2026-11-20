# Security Policy

This page covers how to report a vulnerability, what Snaglet can reach on your machine, and what
it sends over the network.

## Reporting a vulnerability

Report security issues privately, not in a public issue: open a
[GitHub security advisory](https://github.com/snaglet-org/snaglet/security/advisories/new) through
GitHub's private vulnerability reporting.

Include steps to reproduce and the impact you observed. Reports are acknowledged as soon as
reasonably possible, but there is **no formal SLA, triage team, or bug-bounty program**.

## What to expect

- Best-effort responses, not guaranteed turnaround times.
- Fixes prioritized by real-world impact.
- Credit in the changelog if you want it (optional).

## Things you should know before running Snaglet

Agents act with your user account's permissions. With the tools you allow, they
can run shell commands, edit files, and use your browser or desktop, so only
grant tool access to agents and prompts you trust. New agents ask before they
run shell commands, write files, run SQL, use git or call a destructive tool. Your
workspace, database and files stay on your machine, in your Snaglet home and your
linked folders, unless you send them somewhere. The Snaglet home is `~/.snaglet` for the
app and `~/.snaglet-dev` for a source checkout. Content you send to an LLM provider
you configure is subject to that provider's terms. API keys are encrypted at
rest with AES-256-GCM using your `CREDENTIAL_ENCRYPTION_KEY`; keep that key and
your `.env` file private (both are gitignored by default).

Agent-written SQL never runs as the app's database superuser. The read tools
(`database_query`, and the `table` tool's SQL read mode) run as dedicated
read-only PostgreSQL roles: PostgreSQL itself refuses those queries any write,
any read of stored credentials (provider keys and OAuth tokens, MCP API key
hashes, MCP server headers/env), and server-side file or program access such as
`pg_read_file` or `COPY … TO PROGRAM`; they time out after 5 seconds. The raw
write tools (`database_execute` and `create_view`) run as `snaglet_workspace_writer`,
a role that can do anything to custom Database tables (the `user_tables` schema)
and nothing to Snaglet's own tables: agents, messages, memories, credentials, hooks,
the table catalog and the migrations ledger are all denied by PostgreSQL, as is
`CREATE` in `public`; statements time out after 30 seconds. The structured
`table` tool and the UI stay on the app role. See
[Agent SQL roles](docs/architecture.md#agent-sql-roles). A committed
`DELETE` or `DROP` on a custom table still has no undo, so `database_execute`
asks for confirmation by default.

The server listens on `127.0.0.1` unless you set `SNAGLET_BIND_HOST`. The packaged
app passes the server a per-session token (`SNAGLET_AUTH_TOKEN`) that `/api` requests
and the WebSocket must present. A source checkout sets no `SNAGLET_AUTH_TOKEN`, so any
process on your machine can call its API with full access. If you expose the
server beyond your own machine, set `SNAGLET_AUTH_TOKEN`.

The local server only answers requests whose `Host` header names this machine
(`localhost`, `*.localhost`, an IP address, `SNAGLET_BIND_HOST`, the hosts in
`API_BASE_URL` / `SNAGLET_ALLOWED_ORIGINS`, or `SNAGLET_ALLOWED_HOSTS`); anything else
gets `421`, which stops DNS-rebinding pages from reading the API when no
session token is set. Routes that return or mint secrets (credential export,
MCP key minting, the raw database routes) also refuse cross-site browser
requests. Put a reverse proxy's hostname in `SNAGLET_ALLOWED_HOSTS`
(`apps/server/src/middleware/requestOriginGuard.ts`,
`apps/server/src/config/corsOrigins.ts`).

Built-in tools that start other programs (`screenshot`, the `git` and
`imessage` integrations, the `search` tool's code lane) pass arguments directly
to the program, never through a shell, and refuse git remotes, branches and
refs that start with `-`. `shell` is the exception by design: it runs a shell
command, so treat it as full shell access.

## Network access

Snaglet has no account, no Snaglet server and no telemetry. These are the connections it makes:

- **Model providers.** Each agent's requests go to its provider: your messages, the agent's
  instructions, the thread history it replays and the results of its tool calls. Apple
  On-Device, and Ollama and LM Studio at their default local addresses, stay on your machine.
- **Provider sign-in.** Snaglet can reuse logins that other tools saved on your machine: the Claude
  Code CLI's login in the macOS keychain, and the Codex CLI's `~/.codex/auth.json`. Signing in
  with Claude Code, OpenAI Codex, GitHub Copilot or Google Workspace talks to that provider, and
  some of these open your browser. Snaglet refreshes a Codex login at auth.openai.com.
- **Release check.** Once a day the server asks GitHub's releases API whether a newer Snaglet release
  exists. The request is unauthenticated and carries no stored credential.
- **Model downloads from Hugging Face.** The embedding model (about 137 MB) downloads on its own
  in the packaged app and in a source checkout with `SNAGLET_LOCAL_INTELLIGENCE=true`, or when you run
  `pnpm embedder:fetch`. Voice models (from Hugging Face and GitHub) download when you choose
  **Download voice models**, and the optional reranker model only after you turn on its feature
  flag.
- **PostgreSQL runtime.** A source checkout's first run downloads the PostgreSQL source from
  postgresql.org and pgvector from GitHub. On Windows, the PostgreSQL binaries come from
  get.enterprisedb.com.
- **Apple speech.** On macOS 26, the first dictation may have macOS download Apple's on-device
  speech model.
- **Tools agents call.** `web_search` queries DuckDuckGo. `web_fetch`, `screenshot` and the
  `browser` tool load the pages an agent asks for. `orient` with `mode: "local"` looks up your
  approximate location from your public IP address (ipwho.is, falling back to ipapi.co).
  `text_to_speech` sends text to OpenAI, and `image_generate` sends
  its prompt to OpenAI, Google Gemini or Together AI (the one the agent names, or the first with a
  saved credential), whatever model the agent itself uses. Integrations such as Google Workspace
  and git remotes reach their services.
- **Custom tools.** Deploying a custom tool runs `pnpm install`, which downloads its
  dependencies from the npm registry.
- **MCP servers you add.** They connect wherever they are built to. A server configured as an
  `npx` command is installed from the npm registry.

## Supported versions

Snaglet is at 1.x. Only the latest release is supported; older releases do not receive backported
fixes.
