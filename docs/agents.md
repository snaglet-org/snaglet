# Agents

An agent is a lasting AI teammate with its own model, instructions, tools and memories. It keeps
its settings across every thread it joins.

## Using it

### The agent page

Open an agent from the **Agents** view.

| Tab                 | What you set there                                      |
| ------------------- | ------------------------------------------------------- |
| **Overview**        | Model, voice and **Summary model**                      |
| **Behavior**        | Identity, system prompt, and the Direct messages switch |
| **Capabilities**    | Tools, skills and MCP servers                           |
| **Memories**        | What the agent remembers ([Memories](./memories.md))    |
| **Direct messages** | Your home thread with the agent, and its DMs            |

- **Identity** is the agent's persona; **System prompt** is its instructions.
- Either field can transclude a doc or one of its sections: `![title](doc-id#h=section)`. The
  agent reads the doc as it is when each reply starts, so editing the doc changes the agent.
  Replace the transclusion with text to stop. The starter agents, Patty and Clio, follow their
  design docs in the **Agents** folder this way.
- The page updates live when anything else changes the agent. If you are typing in the changed
  field, your text stays until you pick **Reload to see it** or **Keep mine**. Nothing saves until
  you pick. An archived or deleted agent's page says so.
- Tool access (**All**, **Allow list**, **Deny list**) and approvals are covered in
  [Tools](./tools.md). A notification tells you when an agent waits for your approval or answer.
- When an agent uses your Mac's pointer, a flower with its name follows it; see
  [Tools](./tools.md).

### Instructions for all agents

The **Instructions for all agents** card on **Home** holds text Snaglet adds to every agent's
instructions in every thread. You edit it there. An agent can replace it with the
`workspace_instructions` tool, but only after you approve the exact text in the chat; Home shows
the change at once.

### Per-thread setup

A thread's settings → **Agents** tab can give one agent its own model, tool access, skills and
limits in that thread, plus extra instructions added to its own (never replacing them).

### Skills

- A skill is reusable instructions an agent loads only when needed. The **Skills** view lists them.
- Built-in skills work for every agent. Your own live in `~/.snaglet/skills/` and work once
  assigned. Skills are global, not per project.

### Helpers (subagents)

- An agent can hand a self-contained task to a named helper, keep working, and get a report back.
- Live helpers show as chips in the composer strip. Open one to see its thread and talk to it;
  pause, resume or remove any helper.

## How it's built

Paths are relative to `apps/server/src/services/` unless they start with `apps/`, `packages/` or
`tests/`.

| Part                     | Code                                                   |
| ------------------------ | ------------------------------------------------------ |
| Routes                   | `apps/server/src/domains/agents/agents.routes.ts`      |
| Rows, config resolution  | `AgentService.ts`, `ConfigResolverService.ts`          |
| System prompt            | `SystemPromptComposer/`                                |
| Skills                   | `skills/`, built-ins in `apps/server/builtin-skills/`  |
| Helpers, `subagent` tool | `subagents/`, `ToolService/tools/agents/subagent/`     |
| Starter agents           | `onboarding/`                                          |
| Agent page               | `apps/desktop-ui/src/pages/Dashboard/views/AgentView/` |

Tables: `agents` (name, role, identity, system prompt, model and fallbacks, tool access, MCP
servers; `parent_agent_id` marks a helper; agents are not tree nodes), `thread_participants`
(per-thread overrides, via `members`), `skill_registry` and `skill_assignments`, `subagents`, and
`memories`. Every agent write sends `agent.updated`
([Architecture](./architecture.md#agent-changes)).

### A turn

When a message wakes an agent ([who wakes](./architecture.md#message-dispatch)), Snaglet builds the
system prompt, replays the history, appends a short turn-context message, calls the model, runs
its tool calls and sends the reply (`SocketService/handlers/chatPhases/runAgentTurn.ts`,
`turnLoop.ts`).

`resolveAgentConfig` expands transclusions in Identity and System prompt on every read of the
agent row, so each turn uses the doc as it is.

### The system prompt

`composeSystemPrompt` runs the blocks in `SystemPromptComposer/blocks/` in a fixed,
stable-to-volatile order, because provider prompt caching needs a byte-identical prefix.

| #   | Block                        | Covers                                          |
| --- | ---------------------------- | ----------------------------------------------- |
| 1   | `identityBlock`              | Who the agent is, persona, instructions         |
| 2   | `toolDiscoveryBlock`         | Search before saying no; blocked, missing tools |
| 3   | `operatingContextBlock`      | What Snaglet is, where things live, linking     |
| 4   | `goldenRulesBlock`           | Check, be truthful, act, verify, stay in scope  |
| 5   | `howToActBlock`              | Browser and desktop safety, visuals, a sample   |
| 6   | `perceptionBlock`            | Docs, tables, memory, browser, per tools held   |
| 7   | `runModeBlock`               | Threads, routing, mentions, handoffs            |
| 8   | `subagentBlock`              | When to use helpers                             |
| 9   | `toolCatalogBlock`           | Pinned MCP tools, within a text budget          |
| 10  | `workspaceInstructionsBlock` | **Instructions for all agents**, from Home      |
| 11  | `skillCatalogBlock`          | The `## Skills` list                            |
| 12  | `threadSystemPromptBlock`    | Thread instructions: last for caching only      |

- Per-turn data (coordinates, project, routing, recalled memories, unread DMs, a pointer to a
  failed or stopped prior run) goes in the turn-context message
  (`SystemPromptComposer/composeTurnContextTail.ts`), after the history, never stored.
- A helper gets the same blocks without handoff, routing, DM, Creating skills, ask-the-user or
  collaboration-skill text. Its `parentAgentId` never changes, so its prompt stays cache-stable.

Rules for prompt changes:

- Teach how Snaglet works: parts, limits, delivery, integrity, safety. Tone, verbosity, initiative
  and check-ins belong to each agent's persona and instructions, which the user writes.
- Give each rule one home: one block, or none when the tool's description already says it.
- Gate capability text on the tools the agent holds.
- A feature behind an off flag gets no prompt or skill text; put its guidance in its tool
  description.
- Say when to load a skill in its `description`, not in a block.
- Update `tests/unit/apps/server/services/SystemPromptComposer/`, and the prompt evals in
  `tests/integration/apps/server/evals/promptEval/` when behavior changes.

### Skill files and rules

The prompt lists each skill's description; the `skill` tool (`op: "load"`) loads the full text, so
a skill costs tokens only when used. Built-ins are `apps/server/builtin-skills/<slug>/SKILL.md`:

| Skill                   | Role       | Covers                                    |
| ----------------------- | ---------- | ----------------------------------------- |
| `snaglet-agent-collab`  | hub        | The four ways to reach another agent      |
| `snaglet-group-threads` | leaf       | Peers in one thread                       |
| `snaglet-other-threads` | leaf       | Agents in other threads, starting threads |
| `snaglet-dms`           | leaf       | Direct messages                           |
| `snaglet-search`        | standalone | Which search fits, reading long docs      |
| `snaglet-projects`      | standalone | Projects and linked-folder search         |
| `snaglet-sdk`           | standalone | Scripts, custom tools, hooks, automations |

- The hub says which route to take and points to a leaf. Helpers see no collaboration skills.
- Extra files beside `SKILL.md` hold rare detail. The agent reads one with `skill` op `read`.
- A name over 80 characters or a description over 1,024 makes a skill invalid and drops it from
  the list. The body has no limit (`load` pages it); files over 8 MB are refused.
- A user skill with a built-in's slug wins. Renaming a folder makes a new skill; removing one drops
  its row and assignments.

### Helper rules

A helper is an agent row with `parent_agent_id`, in a hidden thread, tracked in `subagents`. It
runs on a model from its orchestrator's effective provider, never a fallback. The core `subagent`
tool has ops `start`, `send`, `wait`, `stop`, `pause`, `update`, `remove`, `list`, `models` (see
its `TOOL.md`).

- **Access** is the orchestrator's live access in the parent thread, re-read on every resolution
  (`subagents/helperInheritance.ts`). `tools` on `start` only narrows it. Helpers never get
  `subagent`, `memory`, `ask` or `automation` (`SUBAGENT_DENIED_TOOL_IDS`,
  `packages/shared/constants/toolCatalog.ts`), and use the orchestrator's MCP connections,
  confirmation settings and credential.
- **Results** arrive as one orchestrator-only event row in the parent thread. A running
  orchestrator reads it at its next tool call; an idle one is woken. `wait` returns results inside
  the turn.
- **Cleanup**: a finished helper goes once its result is seen; a failed or paused one stays for
  `send`. Helpers idle for a day are swept.
- **The rule**: no permission comes from the helper's own row or thread. Enforced by
  `tests/integration/apps/server/subagents/` and `tests/unit/apps/server/services/subagents/`.

```bash
pnpm test:unit -- SystemPromptComposer           # prompt text
pnpm test:integration -- apps/server/subagents   # helper lifecycle
```

## Related

- [Threads](./threads.md)
- [Memories](./memories.md)
- [Tools](./tools.md): tool access, ask-first, custom tools, the computer tool and agent cursors
- [Providers](./providers.md)
- [MCP: client and server](./mcp.md)
- [Architecture](./architecture.md)
