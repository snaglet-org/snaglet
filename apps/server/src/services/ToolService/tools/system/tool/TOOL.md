# tool

Use this whenever the tool you need is not in your list. Your list holds only the tools loaded now, not everything you can do. Never tell the user you can't do something, or that a tool is missing, until you have searched.

1. `tool({op: 'search', query: 'color theme'})`: name the thing or the verb.
2. `tool({op: 'schema', name: '<id>'})` for the parameters of the one you pick.
3. `action({tool: '<id>', params: {...}})` to call it. A tool you used earlier
   is called the same way again; you never "lose access" to it.
4. A match under `blocked` exists but your tool access does not allow it: tell
   the user it is blocked by your permissions (Agents → you → Capabilities),
   not that it is missing.
5. No match: try other words, then create the tool with `custom_tool`
   (`op: 'create'`) and call the `tool_id` it returns.

Always available: no allow or deny list removes it. `op: search` finds tools by capability; `op: schema` returns one tool's full schema (`name` = id, display name or alias; `tool` is accepted in place of `name`). `search_tools`, `list_tools` and `get_tool_schema` are op-pinned aliases of it.

## op: search

Search for tools by capability. Returns `id` (snake_case), display
name, and description. Results are merged from two sources: DB-backed tools
(via semantic/keyword search) and the calling agent's live, enabled MCP
server tools (ranked lexically and fused in via RRF) — so a hit may be a
built-in tool or a live MCP tool the agent currently has access to.

**Tier:** core
**Type:** builtin

## Parameters

| Name      | Type    | Required                  | Description                                                                                                    |
| --------- | ------- | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `query`   | string  | No (not for `mode: list`) | Capability search text matched against tool names, descriptions, and embeddings.                               |
| `mode`    | string  | No                        | One of `hybrid` (default), `semantic`, or `keyword`. Controls the retrieval channels to execute.               |
| `explain` | boolean | No                        | Include per-result ranking `reasons` and a `ranking` block (query verbs/objects) for debugging. Default false. |

## Output

Each result includes:

- `id` — snake_case identifier to pass to `tool(op:schema)` or invoke
- `name` — human-readable display name
- `description` — what the tool does
- `score` — final ranking score (normalized retrieval base plus exact-match,
  verb and object evidence; see `ranking.ts`)
- `reasons` — short tags explaining the score (only with `explain: true`)

`tools` holds primary matches (distinct capabilities, at most 3). When other
tools from the winner's family do a different thing (e.g. `database_execute`
after `database_query` won), they are listed under `related` instead of taking a
primary slot; the key is omitted when empty.

`next` is always present and says what to do with the result: with matches,
read the schema and call through `action`; with none, search again or create
the tool with `custom_tool` (or, for an agent that cannot reach `custom_tool`,
ask the user to add one with **Tools view → New tool**).

Live MCP server tools are only included when the request carries an
`agentId` context and the agent has that server enabled — results are
pre-filtered to what the calling agent can actually invoke.

`blocked` (with `blocked_note`) lists tools that exist and would have been top
matches, but the calling agent's tool access hides them (an allow list that
does not name them, or a deny entry). They are never in `tools`. The key is
omitted when nothing is blocked.

## Example Input

```json
{ "query": "workspace doc" }
```

## Example Output (partial)

```json
{
  "tools": [
    {
      "id": "create_doc",
      "name": "Workspace Create Doc",
      "description": "Create a workspace document...",
      "score": 5.5
    }
  ],
  "related": [
    {
      "id": "get_doc",
      "name": "Get Doc",
      "description": "Fetch a workspace document...",
      "score": 1.5
    }
  ],
  "count": 1,
  "search_query": "workspace doc",
  "search_mode": "hybrid",
  "next": "Read a tool's parameters with tool({op: 'schema', name: '<id>'}), then call it with action({tool: '<id>', params: {...}})."
}
```

## Notes

- Use `id` from results with `tool(op:schema)` when you need the exact
  input contract before invoking the tool.
- Validate inputs against `definition.ts` before changing handler behavior so docs, runtime, and DB metadata stay in sync.
