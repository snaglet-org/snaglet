# Search

Search covers everything in the workspace: docs, threads, containers, agents, messages,
memories, tools, tables and project files. It runs on your machine.

## Using it

| Where                  | What it searches                                            |
| ---------------------- | ----------------------------------------------------------- |
| **Cmd/Ctrl+K**         | Everything                                                  |
| Sidebar search and `@` | Everything, as you type                                     |
| **Cmd/Ctrl+F**         | Inside the open doc or thread. In a table, the table's rows |

In **Cmd/Ctrl+K**:

- Narrow with a prefix such as `doc:`, `thread:` or `table:`, or click a filter at the bottom.
- Search table rows with `entry:` and some words. Add a table name to search one table:
  `table:reading_list entry: draft`.
- Picking a message opens its thread on that message, highlighted until you scroll, click or
  press a key.

## Keyword and meaning

Search matches by keyword and, once items are indexed, by meaning. "What did we decide about
pricing" can find a doc that never uses those words.

- Results list keyword matches first, then the five closest matches by meaning, even when none
  is close.
- **Settings → Embeddings** shows how much is indexed.
- It also lists each table with its **Search by meaning** switch. Tables up to 10,000 rows are
  indexed automatically. Bigger ones are off until you turn them on.
- Keyword search uses English word stemming.

## How it's built

- Search code: `apps/server/src/services/search`. The command palette calls
  `apps/server/src/routes/palette-search.ts`.
- Embeddings: `apps/server/src/services/embedding`.
- Ranking, the embedding model and indexing are described in
  [Search and embeddings](./architecture.md#search-and-embeddings).
- Agents use the same search through the `search` tool. See [Tools](./tools.md).

## Related

- [Tables](./tables.md)
- [Memories](./memories.md)
- [Projects](./projects.md)
