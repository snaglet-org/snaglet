#!/usr/bin/env node
/**
 * A minimal MCP stdio server for tests: newline-delimited JSON-RPC with
 * initialize, tools/list (one `whoami` tool) and tools/call. `whoami` reports
 * the process it runs in — pid, parent pid, argv and the head of PATH — so a
 * test can see exactly how Snaglet started it. It never echoes env values.
 */
const readline = require('node:readline');

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-stdio-server', version: '1.0.0' },
      },
    });
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          { name: 'whoami', description: 'Report this process', inputSchema: { type: 'object' } },
        ],
      },
    });
  } else if (method === 'tools/call') {
    const report = {
      pid: process.pid,
      ppid: process.ppid,
      argv: process.argv.slice(2),
      pathHead: (process.env.PATH || '').split(require('node:path').delimiter)[0],
      tokenLength: (process.env.FIXTURE_TOKEN || '').length,
    };
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify(report) }] },
    });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } });
  }
});
