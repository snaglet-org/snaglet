# MCP: client and server

Snaglet speaks MCP both ways. As a client, your agents use the MCP servers you add. As a server,
Snaglet opens its workspace to outside MCP clients such as Claude Code or Cursor.

## Snaglet as a client

The **MCP** view lists the MCP servers you add. Snaglet ships none.

1. Add a server and give it any credential it needs.
2. Run **Test Connection**.
3. Turn it on for the agents that should use it.

- A server starts only when an agent needs it and stops after 10 idle minutes.
- Its tools appear to agents as `mcp__<server-id>__<tool-name>` and follow the agent's tool access.
  See [Tools](./tools.md#mcp-servers).

## Snaglet as a server

Outside clients work in the same docs, threads and tables as your Snaglet agents. The endpoint is
`/mcp` on the running Snaglet server, which listens only on your own machine (loopback) by default.

### Connect a client

1. In Snaglet, open **MCP** in the activity bar, then **Client connections**, and
   press **+**. Name the client and create it.
2. Copy the key right away. Snaglet shows it once and stores only a hash. If you
   lose it, create a new connection.
3. Paste the setup from the connection's **Connect** section. It fills in your
   key and offers a Claude Code command, an `mcpServers` JSON block for other
   clients, and the HTTP URL with its header.

For Claude Code the command looks like this:

```bash
claude mcp add snaglet --env SNAGLET_MCP_KEY=<your-key> -- snaglet mcp
```

`snaglet mcp` is a small stdio bridge from the `snaglet` command line. The installed app
picks a new port every launch, and the bridge finds the current one for you, so
prefer it over a fixed URL. When `snaglet` is not on your `PATH`, the **Connect**
section uses its full path instead.

Each key belongs to its own workspace member. Everything the client creates or
edits is attributed to that member. Revoke a key from the same panel; it stops
working at once.

### Connect over HTTP

Clients that speak MCP streamable HTTP can call the endpoint directly. Send
`Authorization: Bearer <your-key>` on every request. The endpoint is stateless,
accepts POST only, and answers plain JSON. With `pnpm dev` the server runs on
port 4001:

```bash
curl -s -X POST http://localhost:4001/mcp \
  -H "Authorization: Bearer <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### How the bridge finds Snaglet

`snaglet mcp` reads the key from `SNAGLET_MCP_KEY` or `--key`. It picks the server in
this order: `--server`, then `SNAGLET_SERVER_URL`, then the running app's
`<SNAGLET_HOME>/runtime/desktop-cli-session.json`, then `serverUrl` in
`<SNAGLET_HOME>/config.json`, then `http://localhost:4001`. It re-reads the session
file for every message, so it follows the app across restarts.

### What a client can do

Outside clients get a curated set of workspace tools, each named with an
`snaglet_` prefix: threads, agents, models, search, docs, nodes, containers, tables,
the calendar, automations and node export. They never get shell, memory, image
creation or admin tools. `snaglet_export_node` is the only tool that writes a file
onto the Snaglet machine.

Some limits to know:

- **No ambient context.** Call `snaglet_node` op `tree` or `get` first, then pass
  explicit ids.
- **No deletes or archives.** Those stay in the app.
- **Code and file search** stay inside linked project folders.
- **Linking a project folder** happens in the app, not over MCP.
- **Automations** can be read freely, but a client changes only the ones it
  created.

Each tool's schema lists only the ops a client may use, and Snaglet refuses any
other op with a short error before the tool runs. For agents, threads, models,
nodes, containers and tables the schema also lists only the fields each op
takes, and Snaglet refuses any other field the same way; search and node export
list only the kinds a client may use. The other tools take their in-app fields
and check them as they do in the app. The description adds only what a schema
cannot say: that there is no ambient thread, what is attributed to the
client's member, and which writes work only on what that member created.

## Troubleshooting

- **401 Missing API key**: send the `Authorization: Bearer <key>` header.
- **401 made by a different Snaglet home**: the key belongs to another Snaglet, such as
  the installed app when you are calling a dev server. Use the matching Snaglet or
  create a key here.
- **401 Invalid or revoked API key**: create a new key.
- **405**: a client probed with GET. This is harmless.
- **Connection refused**: Snaglet is not running, or the port is wrong. Use
  `snaglet mcp`.

## Where the code lives

| What                         | Where                                                       |
| ---------------------------- | ----------------------------------------------------------- |
| Endpoint and auth            | `apps/server/src/domains/mcp/mcp.routes.ts`, `mcpAuth.ts`   |
| What is open, and its schema | `apps/server/src/domains/mcp/mcpProjection.ts`              |
| Per-call limits              | `apps/server/src/domains/mcp/McpGatewayService.ts`          |
| Key management API           | `apps/server/src/domains/mcp/mcpApiKeys.routes.ts`          |
| Client connections panel     | `apps/desktop-ui/src/pages/Dashboard/views/McpConnections/` |
| stdio bridge                 | `packages/snaglet-cli/src/mcp-bridge.mjs`                   |

Exposure is decided only in `mcpProjection.ts` and `McpGatewayService.ts`,
never in a tool's own definition. `mcpProjection.ts` holds it as data: the
curated tools, their ops (`CURATED_TOOL_OPS`), the fields each op takes
(`EXTERNAL_OP_PARAMS`) and the enum values a client may use
(`EXTERNAL_ENUM_VALUES`). The published schema is built from that data and
the gateway checks calls against the same data, so the two cannot drift.
