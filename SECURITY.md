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

## How Snaglet handles security

- **Agents act as you.** With the tools you allow, an agent can run shell commands, edit files,
  and use your browser or desktop. Give tool access only to agents and prompts you trust.
- **New agents ask first.** They confirm before running shell commands, writing files, running
  SQL, using git or calling a destructive tool.
- **Only you can turn the questions off.** An agent runs those tools without asking only after
  you choose it yourself: **Agents** → select the agent → **Capabilities** → **Tools** →
  **Trusted mode** → **Confirm**. Trusted mode never gives an agent more tools, and **Guarded
  mode** turns the questions back on. You can also stop the question for a single tool, in the
  same **Tools** section or in a thread's settings.
- **Your data stays on your machine.** Your workspace, database and files live in your Snaglet
  home (`~/.snaglet`) and your linked folders, unless you send them somewhere.
- **What you send to a model goes to that provider.** It is covered by that provider's terms.
  See [Network access](#network-access).
- **API keys are encrypted on disk.**
- **Agents cannot read your keys or change Snaglet's own data with SQL.** The database refuses
  it. Agents can read and change the tables you create.
- **Deleting has no undo.** A `DELETE` or `DROP` on one of your tables is permanent, so agents
  ask before running one.
- **The `shell` tool is full shell access.** Treat it that way.
- **The app only listens on your own machine.** Other devices on your network cannot reach it.

### If you run from source or change the defaults

- **A source checkout has no session token.** Any program on your machine can call its API with
  full access. The downloaded app sets a token for each session.
- **Exposing the server beyond your machine is your responsibility.** Set `SNAGLET_AUTH_TOKEN`
  first. Setting `SNAGLET_BIND_HOST` is what makes the server reachable from elsewhere.
- **Behind a reverse proxy, name its host.** The server only answers requests addressed to this
  machine and returns `421` to anything else. Add the proxy's hostname to `SNAGLET_ALLOWED_HOSTS`.
- **Keep `.env` and `CREDENTIAL_ENCRYPTION_KEY` private.** That key encrypts your API keys
  (AES-256-GCM). Both are gitignored by default. A source checkout's Snaglet home is
  `~/.snaglet-dev`.

### How the protections work

- **SQL.** Each agent SQL tool runs as its own locked-down PostgreSQL role, never as the app's
  database user. Reads time out after 5 seconds and writes after 30. See
  [Agent SQL roles](docs/architecture.md#agent-sql-roles).
- **Web pages cannot call the API.** Requests not addressed to this machine are refused, which
  stops DNS-rebinding attacks. Routes that return or create secrets also refuse cross-site
  browser requests.
- **Tools that start other programs do not go through a shell.** `screenshot`, `git`, `imessage`
  and code search pass arguments directly, and git remotes, branches and refs that start with
  `-` are refused. `shell` is the exception by design.

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
