# Threads

A thread is a conversation between you and one or more agents. A direct message (DM) thread is a
private thread between two members: you and an agent, or two agents.

## Using it

### Who answers

- Create a thread from the **+** menu and add agents on the **Agents** tab of its settings.
- Type `@` and a name to mention an agent. Agents can mention each other, which wakes the next one.
- Thread settings → **Routing**: **All (broadcast)** wakes every agent. **@mention only** (the
  default) wakes only mentioned agents, but a thread with one agent (archived ones don't count)
  answers every message.
- With **@mention only** and several agents, a message that mentions none wakes nobody, and
  Snaglet hints to mention one.
- A message that mentions more than four of the thread's agents, in either mode, is saved but
  wakes no one.

### Bringing agents in and out

Every agent in a thread adds to the cost of each message, so agents keep the room small:

- An agent adds a specialist (or an agent you ask about), asks, and takes it out when done. One
  brought in for a question leaves on its own. The chat shows "joined" and "left" lines.
- An agent you set up for the thread (model, tools, instructions, skills, limits, or auto-respond
  off) stays until you remove it.

### Thread settings

- **General**: project, text size, thread instructions, limits, **Compress all contexts**.
- **Routing**: who answers. **Folder**: the folder agents start in.
- **Agents**: each agent's model, tools and instructions in this thread, its memories and summaries
  (see [Memories](./memories.md)).
- **Maintenance**: trimming and clearing.

### Images

- Paste, drop or attach (paperclip) an image up to 50 MB. A model that can't take it gets a smaller
  copy and your original is kept. One that can't shrink enough (over 100 megapixels) is left out,
  and the model is told so.

### When agents stop

Bracketed lines in the chat say why agents stopped:

- `[agent run ended · Nova · 1m12s · 7 tool calls]`: Nova finished its turn.
- `[name] aborted [Nova]`: that name (you, an agent or an MCP client) stopped Nova. `[watchdog]`
  means Snaglet released a stuck run.
- `[summary model … · run stopped …]`: see [Memories](./memories.md#summaries-and-compaction).
- `[conversation ended · <reason> · …]` ends with the waves run and output tokens used:
  - `everyone passed`: the normal ending. A one-agent thread shows no line for it.
  - `repetition detected`: an agent kept repeating itself.
  - `wave limit reached`: the **Max dispatch waves** limit (a wave is one round of replies; off
    unless set).
  - `output budget reached`: the **Conversation budget** of output tokens per message (192,000
    by default). A reply already started is never cut.
  - `ended on an error`.
- After a limit or budget ending, your next message continues with a fresh limit and budget. Both
  are set on the **General** tab.

### Screen, camera and voice

- The composer's vision control grants an agent your screen, camera, or both. The agent takes one
  frame when it needs to see, deleted after the turn unless you ask to keep it. On macOS, re-allow
  a declined camera in **System Settings → Privacy & Security → Camera**.
- **Dictation** (microphone) types your speech into the message box. **Voice mode** (waveform) also
  sends it and reads replies aloud. macOS 26 or later uses Apple's on-device recognition; otherwise
  Snaglet uses its own voice models.
- Voice mode needs a voice from **Settings → Local storage → Voices**. An agent speaks with its
  chosen voice, or the first installed one while that is missing.

## Direct messages

An agent's **Direct messages** tab lists its DM threads, which stay out of the Workspace tree,
thread lists and search:

- **Home thread**: your private conversation with the agent. Your message wakes it. In the header,
  **Fork thread to workspace** copies it into a normal thread and **Clear** deletes its messages.
- **Agent-to-agent DMs** ("Patty ↔ Clio"): read-only for you. **Clear** empties one; **Delete**
  removes it. A DM doesn't wake the recipient; it sees an "Unread DMs" note on its next run.
- A home thread can't be deleted, archived or moved into a project, by anyone. Deleting the agent
  removes it, with all the agent's DMs.
- Turn off **Direct messages** on the agent's **Behavior** tab to stop its DMs. History stays.

## How it's built

Paths are relative to `apps/server/src/services/` unless they start with `apps/` or `packages/`.
Waking agents, waves, budgets and stop reasons are in
[Architecture](./architecture.md#message-dispatch); the turn is in [Agents](./agents.md#a-turn).
How a thread's history is replayed so providers can reuse it is in
[Prompt caching](./prompt-caching.md).

| Part                         | Code                                                  |
| ---------------------------- | ----------------------------------------------------- |
| Routes, fork, agent removal  | `apps/server/src/domains/threads/`                    |
| Models                       | `packages/db/tables/threads/`, `thread_participants/` |
| `thread` tool ops            | `ToolService/handlers/threads/`                       |
| DMs, home-thread guard       | `dm/DmService.ts`, `homeThreadGuard.ts`               |
| Live roster                  | `SocketService/dispatch/`                             |
| Agents leaving mid-run       | `SocketService/handlers/chatPhases/`                  |
| Chat UI (DM UI in `DmView/`) | `apps/desktop-ui/src/pages/Dashboard/views/ChatView/` |

Bare file names below live in these folders.

Tables:

- `threads`: `kind` (`chat` or `dm`), `dispatch_mode` (`all` or `mentioned`),
  `thread_system_prompt`, limits, tool access, `working_directory`, `dm_pair_key`.
- `thread_participants`: one row per member, with per-thread overrides and `last_read_at`.
- `messages`, and `thread_summaries` for digests and compactions.

### Membership rules

- Agents join and leave only through `thread` ops `add_agents`, `remove_agents` (others, in a
  thread the caller is in) and `leave` (itself), never `update`.
- External MCP clients can add agents but not remove them.
- Removals share `removeAgentParticipant.ts` with the app's Remove button, so the chat shows the
  usual "left the thread" line.
- Neither op removes an agent with per-thread setup; `perThreadSetup.ts` names it in the refusal.
- `runModeBlock` teaches this to agents holding `thread`, except in a helper's own thread.
- Every add or remove bumps the roster version (`rosterVersion.ts`). A running dispatch re-reads
  its roster before the next mention or wave (`liveRoster.ts`).
- A speaker that left mid-run wakes nobody (`routeReplyMentions.ts`). In a one-agent thread, a
  message for an agent that just left goes to the one still there (`handOverToRemainingAgent.ts`).

### DM rules

- A DM is an ordinary message in a DM thread, one per pair of members, keyed by `dm_pair_key`.
- Agents use `thread` ops `dm_send`, `dm_list` and `dm_read` (`threadDm.ts`), taught by the
  `snaglet-dms` skill. Unread means newer than the reader's `last_read_at` and not its own.
- `dm_send` never dispatches: `DmService` must not import `dispatchToThread` or its callers. A DM
  from the user takes the normal chat path.
- Limits: 5 sends per run, 4,000 characters each. With `agents.dm_enabled` off, an agent neither
  sends nor receives. Bodies are data in an envelope naming the sender and grant no permissions.
- `packages/db/tables/threads/visibility.ts` hides DM threads from lists, search and embeddings.
  Other `thread` ops refuse a DM thread unless the agent is running in it.
- Every full thread delete runs through `withThreadExecutionPurge`, which calls
  `homeThreadGuard.ts` first: deleting or archiving a home thread answers 403, moving it into a
  project 400. Deleting the agent is the one exception.

## Related

- [Agents](./agents.md)
- [Memories](./memories.md)
- [Prompt caching](./prompt-caching.md): what keeps a long thread cheap, and what breaks the cache
- [Tools](./tools.md): tool access, including per-thread overrides
- [Projects](./projects.md)
- [Search](./search.md)
- [Architecture](./architecture.md#message-dispatch)
