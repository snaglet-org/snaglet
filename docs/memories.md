# Memories

A memory is a short, lasting fact an agent saves and recalls later. Each agent has its own store,
which teammates can't read. Knowledge to share belongs in a doc.

## Using it

- On every wake, Snaglet hands the agent up to five memories that match the incoming message.
- Facts about you that an agent picks up are proposals until you keep them.
- Agent page → **Memories** lists every memory the agent holds, newest first, with its thread.
- Thread settings → **Agents** → **Memories** lists what that agent remembered in this thread,
  proposals about you first: ✓ keeps one (marked **About you**, recallable in the thread), ✕
  removes it. **Export all memories** saves all of the agent's memories as a Markdown file.
- Deleting a memory (its trash button) can't be undone.

### Summaries and compaction

Long threads are folded: older turns become a summary so the model can keep going.

- Thread settings → **Agents**: **Summaries** lists an agent's summaries, and **Compact** folds
  right away. **Compress all contexts** on the **General** tab does every agent.
- The **Summary model** (agent page **Overview**, or per thread on **Agents**) writes summaries. By
  default the agent's own model does.
- An agent new to a thread sees only the newest history that fits 30% of its context window, never
  a summary of what it missed.
- If the summary model can't run, Snaglet never switches models. It stops the run, names the model
  and reason in the chat, and blocks the thread until a working summary model is set (a different
  one, if it failed). `[summary model restored · …]` means the thread works again.

## How it's built

Paths are relative to `apps/server/src/services/` unless they start with `apps/`.

- Table `memories`: owner is exactly one of `agent_id` or `member_id` (a fact about a person);
  `status` is `active` or `proposed`; project comes from `source_thread_id`. Vectors live in
  `embeddings`. Summaries and compactions are `thread_summaries` rows.
- `MemoryService.ts`, `apps/server/src/domains/memories/memories.routes.ts`, and the `memory` tool
  (`ToolService/tools/memory/memory/`). Reusing a key updates that memory.
- Recall: `summary/memoryRecallSegment.ts` queries with the thread title and latest inbound
  message, and adds nothing when no match stands out. It runs only for agents holding `memory`.
  `summary/memoryRecallScope.ts` limits a project thread to its project family plus projects the
  query names.
- The `search` tool returns the same memories: never another agent's, never a proposal
  (`ToolService/handlers/search/workspaceSearch/memoryScope.ts`).
- History compaction: past the fold threshold,
  `SocketService/handlers/chatPhases/historyCompactor.ts` summarizes the oldest whole turns into a
  compaction record that later turns replay from.
- In-run compaction: `contextWindow/runCompaction.ts` squeezes a long run's tool exchanges into a
  short task state. It writes no `thread_summaries` row.
- Newcomers: `SocketService/handlers/chatPhases/newcomerCut.ts`.
- Summary model: `summary/UtilityModelResolver.ts` (thread override, agent override, agent's own
  model). Thread content never reaches a cloud provider the agent doesn't already use unless the
  user chose it. Failures: `summary/summaryHalt.ts`.
- `COMPACT_CONVERSATIONS=false` turns off every summary path.

### Extraction

- After a summary or fold, a second utility-model call reads the same span and saves at most three
  memories (`summary/memoryExtraction.ts`). Facts about the person become proposals.
- Keys are stable and kind-prefixed, and saves upsert by owner and key, so repeat compactions
  refresh rather than duplicate.
- Every compacting path calls the schedulers in `summary/scheduleCompactionMemoryExtraction.ts`,
  never the extractor. They run it in the background, only for a written summary, once each.

## Related

- [Agents](./agents.md)
- [Threads](./threads.md)
- [Search](./search.md)
- [Architecture](./architecture.md#search-and-embeddings)
