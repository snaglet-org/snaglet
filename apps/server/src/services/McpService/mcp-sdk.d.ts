/**
 * Type declarations for @modelcontextprotocol/sdk
 * Provides minimal types when the SDK package is not installed.
 * Remove this file once @modelcontextprotocol/sdk is a proper dependency of apps/server.
 */
declare module '@modelcontextprotocol/sdk/client/index.js' {
  export class Client {
    constructor(
      info: { name: string; version: string },
      opts?: { capabilities?: Record<string, unknown> }
    );
    connect(transport: {
      close(): Promise<void>;
      onclose?: () => void;
      onerror?: (err: Error) => void;
    }): Promise<void>;
    listTools(): Promise<{
      tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    }>;
    callTool(params: {
      name: string;
      arguments?: Record<string, unknown>;
    }): Promise<{ content: unknown[]; isError?: boolean }>;
    close(): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/client/stdio.js' {
  /** The parent env vars a stdio server inherits (HOME, PATH, SHELL, TERM, USER…). */
  export function getDefaultEnvironment(): Record<string, string>;
  export class StdioClientTransport {
    constructor(opts: {
      command: string;
      args?: string[];
      env?: Record<string, string | undefined>;
    });
    onclose?: () => void;
    onerror?: (err: Error) => void;
    close(): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/client/streamableHttp.js' {
  export interface StreamableHTTPClientTransportOptions {
    /** Customizes HTTP requests to the server (used here to inject headers). */
    requestInit?: RequestInit;
  }
  export class StreamableHTTPClientTransport {
    constructor(url: URL, opts?: StreamableHTTPClientTransportOptions);
    onclose?: () => void;
    onerror?: (err: Error) => void;
    close(): Promise<void>;
  }
}
