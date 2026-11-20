# Prompt caching

A provider can reuse the work it did on the start of a request when the next request starts with
the same bytes. Snaglet lays out each turn so most of the prompt repeats exactly, which makes turns
cheaper and faster.

## How a request is laid out

Caches match an exact leading byte sequence, in the order tools, system, messages. Snaglet sends
the parts stable to volatile:

| #   | Part                                 | Changes when                         |
| --- | ------------------------------------ | ------------------------------------ |
| 1   | Tools                                | The agent's tool access changes      |
| 2   | System core                          | The agent's identity or tools change |
| 3   | Instructions for all agents          | That text is saved on **Home**       |
| 4   | Skill list, then thread instructions | The thread's setup changes           |
| 5   | History                              | Appends only, until compaction       |
| 6   | Turn-context message                 | Every turn                           |

Paths below are relative to `apps/server/src/services/` unless they start with `packages/` or
`tests/`.

- Tools are the core set in `CORE_TOOL_ORDER` (`packages/shared/constants/toolCatalog.ts`), in that
  order, plus tools an allow list pins. Others go through `tool` and `action`, so the list never
  grows mid-run.
- Tools and tool-gated system text come from the agent's own access (`AgentToolResolver.ts`), so
  every thread gets the same bytes.
- `SystemPromptComposer/composeSystemPrompt.ts` builds the system prompt
  ([Agents](./agents.md#the-system-prompt)).
- Roster, routing, model, voice and vision changes are appended as `thread_event` messages
  (`SocketService/threadEvents.ts`).
- Replay (`SocketService/handlers/chatPhases/replayAssembly.ts`) places each message by when it was
  written, so nothing lands mid-history.
- The turn-context message (`SystemPromptComposer/composeTurnContextTail.ts`) carries coordinates,
  project scope, recalled memories and similar per-turn notes. It is never stored or replayed.

## Where the cache breakpoints go

- **Anthropic**: four `cache_control` markers, below.
- **OpenAI** (`api.openai.com`) **and Codex**: a `prompt_cache_key`. The provider caches matching
  prefixes itself.
- **Gemini**: nothing is set. Gemini caches implicitly.
- **Copilot, xAI, DeepSeek, Mistral, Together, Ollama, LM Studio**: nothing is set.

Anthropic (`ProviderChatService/providers/anthropic.ts`, `anthropicMessagePrep.ts`):

- Markers go on the last tool, the last system block, the message before the turn-context message,
  and the last message.
- The third marker sits on replayed history, which the next run reads back. The last one serves the
  tool loop inside one run.
- The TTL is `1h`. A model's `cacheTtl` metadata (`5m` or `1h`) changes it for every marker:
  tools, system and messages.
- With a Claude Code login on a non-Haiku model, the first system block is the Claude Code identity
  line (`ProviderChatService/shared.ts`).

OpenAI (`ProviderChatService/providers/shared/promptCacheKey.ts`): the key is a hash of the agent
id, so an agent's threads share one warm cache. Only `api.openai.com` and the Codex backend get it.

## What breaks the cache

Each of these rewrites the prompt from the changed part onward:

- Editing an agent's name, role, persona or system prompt, a doc transcluded into them, or a
  thread's addition to that system prompt (`SystemPromptComposer/blocks/identityBlock.ts`).
- Changing an agent's tool access, including an MCP tool its allow list pins.
- Saving **Instructions for all agents** on **Home**: every agent's system prompt.
- Editing a thread's instructions or skills: that thread's system prompt.
- A history fold or an in-run compaction ([Memories](./memories.md#summaries-and-compaction)). The
  summary replaces the front of the history or run. Tools and system stay cached.
- Tool-result condensing (`SocketService/handlers/chatHelpers/toolResultCondense.ts`). A re-read of
  the same target turns the earlier result into a pointer, and under pressure the oldest results
  are trimmed.
- A model switch or fallback. The new model starts with no cache.
- Switching an Anthropic agent between an API key and a Claude Code login.
- A gap between turns longer than the TTL.

These do not break it: roster, routing, voice and vision changes, a thread's tool-access override,
and the reference linter, since replies are stored as written
(`SocketService/handlers/chatPhases/finalReply.ts`).

## Rules for contributors

- Put per-turn data in the turn-context message and thread state changes in a `thread_event` row.
- A system block may branch only on facts fixed for an agent or a thread's life, such as a DM
  thread, a helper agent or the agent's own tools. Never on the roster or per-turn data.
- Render deterministically: sort lists by id, with no timestamps, random ids or hashes.
- Block builders never set `cache_control`. `composeSystemPrompt` marks the last system block,
  which keeps Anthropic at four markers.
- Keep the tool list fixed for a run and the same in every thread. Editing `CORE_TOOL_ORDER`
  changes every agent's prefix.
- Never rewrite a stored message.

Tests under `tests/unit/apps/server/services/` enforce this (`pnpm test:unit`):

- `SystemPromptComposer/cacheStability.test.ts`: the system prompt survives a roster and mode
  change byte for byte.
- `ProviderChatService/anthropicCacheBreakpoints.test.ts`, `anthropicCacheControl.test.ts`: markers,
  TTL, beta headers.
- `ProviderChatService/providers/promptCacheKey.test.ts`: who gets the key.
- `SocketService/chatPhases/threadToolAccessCatalog.test.ts`, `skillCatalogPerThread.test.ts`: the
  same tools and system bytes across threads.
- `replayAssembly.test.ts`, `SystemPromptComposer/runModeBlock.test.ts`,
  `SystemPromptComposer/turnContextTail.test.ts`: deterministic output.

## Seeing it

The app has no cache readout. Look here instead:

- The server log (`~/.snaglet/logs/server.log` by default) has a `[cache_metrics]` line per call
  with `input` (uncached), `cache_read`, `cache_creation` and `hit_ratio`. Anthropic and Gemini log
  every call, chat-completions providers only calls that hit the cache, Responses API calls none.
- A fallback logs `[fallback_cost]` with `est_wasted_cache_tokens`.
- `runs.cache_read_tokens` and `runs.cache_creation_tokens` hold each run's totals. Only Anthropic
  reports cache writes.

## Related

- [Agents](./agents.md)
- [Tools](./tools.md)
- [Memories](./memories.md)
- [Architecture](./architecture.md)
- [Providers](./providers.md)
