# Tools

A tool is the only thing an agent can run or be granted. An agent's tool access decides which
tools it may call and which ones ask you first.

## Using it

- The **Tools** view lists every built-in tool. **New tool** there makes a custom tool.
- An agent sees a core set of tools and searches for the rest, so it reaches any tool its access
  allows. When nothing fits, it can write a custom tool. A guarded agent asks first, because the
  code runs as you.
- Servers in the **MCP** view add their tools when enabled globally and for the agent.
- If an agent says a tool is blocked by its permissions, allow it on its **Capabilities** tab.

## Tool access

On the agent's **Capabilities** tab, **Tools** has three modes. A thread can override it on the
**Agents** tab of its settings.

| Mode           | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| **All**        | Every tool runs. Only a bare deny entry naming a tool blocks it.         |
| **Allow list** | Listed tools run. Others ask you, or are refused when nobody can answer. |
| **Deny list**  | Everything runs except what the deny list names.                         |

- Deny beats allow. An entry names a tool by id.
- Shell, file, git and SQL entries can take a specifier: `shell(git:*)`, `file(/srv/app/**)`,
  `database_execute(select:*)`.
- `tool` and `get_current_datetime` are always available.

## Asking first

A tool or op set to ask first waits for your approval in the chat. A notification tells you;
click it to go to the question.

- New agents start guarded: shell, file writes, SQL, git and destructive tools ask first. That
  includes `workspace_instructions` `set`, which replaces the **Instructions for all agents** on
  **Home**: the prompt shows the whole new text and its length, so read it before you approve.
  Other tools show their input capped at 2,000 characters.
- **Trusted mode** on the **Capabilities** tab skips the prompts for permitted tools. It never
  widens access. **Guarded mode** turns them back on.
- First match wins: the thread's override for the tool, then **Trusted mode**, then the agent's
  per-tool override, then the tool's default (off) or the MCP server's "require confirmation"
  policy.
- Automation and hook runs have nobody to ask. See
  [Automations](./automations.md#runs-with-nobody-watching) and
  [Hooks](./hooks.md#nobody-watching).

## Shell, browser and computer

These reach outside Snaglet, so each has its own guardrails. Each tool's `TOOL.md` lists its ops.

**Shell** runs commands on your computer.

- Commands get a filtered environment, never server secrets. An agent's commits carry its name.
- Every session has a hard time limit. A background run returns at once and posts its result to
  the agent's thread.
- A git safety rail refuses commands that would throw away others' work or wait for an editor.

**Browser** drives a real Chrome.

- Profiles live in `~/.snaglet/browser-profiles/`, so sign-ins persist apart from your own Chrome.
  The `temp` profile is signed out and keeps nothing.
- An agent's first use of a profile asks you. Each agent sees only its own tabs.
- It never types into password, card or secret fields. Send, delete, buy and similar clicks wait
  until the agent has asked you. `handoff` asks you to finish a login, 2FA or CAPTCHA.
- Site allow and block lists apply. No `eval`, cookie or storage access. Held keys last at most
  5 seconds and never include Tab.

**Computer** drives your macOS desktop: screenshots, the accessibility tree, clicks, typing, keys.

- One agent holds the cursor at a time. You approve its first claim.
- The server needs the Screen Recording and Accessibility permissions.
- Press **Esc**, or choose **Stop agent cursors** from the flower in the menu bar, to stop it.

While an agent uses the pointer, a flower with its name follows it over every app. When the
flowers stop moving, rest the mouse on one (in the Snaglet window, with Snaglet active):

- Click **×** to hide it until the agent next uses the pointer after a couple of minutes' pause.
- Drag it to park it, or off the screen to hide it. Agents wait while you hold a flower.
- Neither stops the agent. Moving the mouse for something else does: the agent then asks before
  it takes the pointer again.

## How it's built

Server paths are relative to `apps/server/src/services/`.

### Kinds of tool

- **Builtin**: one folder in `ToolService/tools/<category>/<tool>/`. The folder path is the
  category, for display only. `table` is `tools/tables/table/`.
- **MCP**: discovered live by `McpService/`, never written to the `tools` table, named
  `mcp__<server-id>__<tool-name>`.
- **Custom**: `~/.snaglet/tools/<name>/` with `definition.json` and `tool.ts`, made with
  `custom_tool` and registered by `ToolService/customTools/CustomToolScanner.ts`.

### The builtin registry

- A folder holds `definition.ts` (snake_case id, name, description, `parameters_schema`, tier,
  keywords), `tool.ts` (the default-export handler) and `TOOL.md` (the agent guide, also embedded
  for tool search; ops and limits go there).
- `ToolService/ToolRegistry.ts` loads every folder with both `.ts` files. There is no list.
- Packaged builds use a generated static registry. Build and typecheck regenerate it; run
  `pnpm --filter @snaglet/server gen:tool-registry` after adding or moving a tool.
- The `tools` table mirrors the folders, synced at boot and by `pnpm db:migrate`
  (`ToolService/lib/syncToolCatalog.ts`). A tool whose folder is gone is disabled, never deleted.
  Never write tool rows in a migration.
- Old ids of renamed tools are aliases in `packages/shared/utils/toolAliases.ts`. Use canonical
  ids in new code and docs.

### Core and on-demand tools

- `CORE_TOOL_ORDER` in `packages/shared/constants/toolCatalog.ts` lists the tools whose schemas
  go to the model every turn.
- Others are found on demand: `tool` with `op: "search"`, then `op: "schema"`, then
  `action({ tool, params })`, which runs the same checks as a direct call.
- Add a core tool only when most agents need it on most turns: each adds its schema to every
  request.

### Tool discovery

- Agents must search before saying they can't do something. The rule lives in
  `SystemPromptComposer/blocks/toolDiscoveryBlock.ts` and the `tool` description.
- A call to a tool the run didn't load is looked up once
  (`SocketService/handlers/chatPhases/toolDispatch.ts`): a reachable tool runs, a blocked one is
  refused with where to allow it.
- With no fit, the agent writes one with `custom_tool`, or asks the user to use
  **Tools → New tool**.

### Where access is enforced

- `ToolService/lib/agentToolPolicy.ts` is the one policy source. `toolVisibility.ts` decides which
  tools an agent may use, and `toolPermission.ts` applies deny rules and specifiers per call.
- Ask-first resolves in `AgentToolResolver.ts`. The guarded set for new agents is
  `ToolService/lib/guardedTools.ts`.
- Chat asks a person. `/api/tools/execute` with an agent id refuses a call that would ask (403).
- A hook with no agent runs as a system actor limited to `GHOST_TOOL_ACCESS` (`table`,
  `thread_send`, `thread_read`, `database_query`).
- Server and UI parse rules with the same code: `packages/shared/utils/toolRules.ts`.

### MCP servers

- `McpService/` starts a server when a call needs it and stops it after 10 idle minutes.
- Both directions are covered in [MCP: client and server](./mcp.md).

### Shell, browser and computer internals

- **Shell**: `ToolService/tools/shell/` (tool folder `shell/shell/`). Environment filter:
  `ToolService/lib/buildSafeEnv.ts`. Time limits: `shellGuardrails.ts`. Git rail: `gitSafety.ts`.
- **Browser**: `ToolService/tools/system/browser/` and `BrowserController/`, on
  `playwright-core`. Site lists: `SNAGLET_BROWSER_ALLOWED_SITES`, `SNAGLET_BROWSER_BLOCKED_SITES`.
- **Computer**: `ToolService/tools/system/computer/`. Real input needs
  `SNAGLET_COMPUTER_ALLOW_INPUT=1`. `POST /api/computer/stop` revokes the claim.
- **Flowers**: the in-app overlay plus, on macOS, `apps/server/native/cursor-overlay/`. Timing
  constants are in `packages/shared/constants/agentCursor.ts`.

### Transclusions in the doc tool

- `doc` reads a doc with each transclusion expanded in place and routes each edit to the doc that
  owns the text (`transclusions/expandTransclusions.ts`, `routeEdits.ts`). See
  [Docs](./docs.md#transclusions).

### Adding a builtin tool

1. Create a kebab-case folder: `ToolService/tools/<category>/<tool-name>/`.
2. `definition.ts`: snake_case id. Set `providerId` if it needs an integration, and
   `destructive: true` (or `destructiveOps` for an `op` tool) for hard-to-undo changes. Don't
   set `categoryPath`.
3. `tool.ts`: `async (input, settings, context) => string | { output, rawContent? }`. Validate
   input and throw clear `Error`s.
4. `TOOL.md`: purpose, ops and limits.
5. Tests in `tests/unit/apps/server/services/ToolService/tools/`, plus
   `tests/integration/apps/server/services/tools/` if it touches the database.
6. Sync the catalog, with an explicit target ([Dev environment](./dev-environment.md)):
   `SNAGLET_ENV=dev pnpm sync:tool <tool-name>`.
7. Regenerate and audit: `pnpm --filter @snaglet/server gen:tool-registry`, then
   `pnpm test:tool-registry`.
8. Try `pnpm tool <tool-id> --key value` and check the **Tools** view.

Move a tool by moving its folder (keep the id). Rename by adding an alias. Retire by deleting the
folder.

### Verifying

```bash
pnpm verify:changed            # touched packages and related tests
pnpm test:unit -- ToolService  # tools and access rules
pnpm test:tool-registry        # builtin registry audit
```

## Related

- [Agents](./agents.md)
- [Automations](./automations.md)
- [Hooks](./hooks.md)
- [Docs](./docs.md)
- [MCP: client and server](./mcp.md)
- [Architecture](./architecture.md)
- [Conventions](./conventions.md)
