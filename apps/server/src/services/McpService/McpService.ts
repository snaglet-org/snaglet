/**
 * McpService: the single gateway to MCP servers. Config lives in the
 * `mcp_servers` table (`.mcp.json` is only a seed); tools are discovered live,
 * cached in memory (never persisted as rows) and exposed as
 * `mcp__<serverId>__<toolName>`. Invariants: a dead subprocess never crashes Snaglet
 * (failures are returned, not thrown); tool-list reads are cache-only and never
 * spawn; only an agent turn or a tool call starts a server, and a failed start
 * backs off for warm-ups only; idle connections stop after IDLE_REAP_MS with
 * their tools still cached; starts are single-flight per connection key.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  MCP_PREFIX,
  DEFAULT_AGENT_BUCKET,
  IDLE_REAP_MS,
  REAP_INTERVAL_MS,
  CONNECT_RETRY_BACKOFF_MS,
  rowToConfig,
  type McpServerConfig,
  type McpToolDef,
  type McpCallResult,
  type McpError,
} from './mcpTypes';
import {
  resolveEnv,
  resolveHeaders,
  configRequiresCredential,
  configCredentialSpec,
  credentialKeyForConfig,
} from './mcpCredentials';
import {
  buildTransport,
  describeConnectError,
  loginPathReady,
  type DirectLaunch,
  type McpClientTransport,
} from './mcpTransport';
import { augmentMcpDescription, buildToolDefs } from './mcpToolProjection';
import { McpInstaller, type McpInstallInfo, type McpLaunchPlan } from './mcpInstaller';

// Public surface (frozen): callers and index.ts import these from './McpService'.
export { augmentMcpDescription };
export type { McpToolDef };

/**
 * A pooled connection to one MCP server. SDK-bound (references the live `Client`
 * and transport), so it lives here with the connection machinery rather than in
 * the SDK-free `mcpTypes` module.
 */
interface McpConnection {
  client: Client | null;
  transport: McpClientTransport | null;
  config: McpServerConfig;
  status: 'connected' | 'disconnected' | 'connecting';
  lastUsedAt: number;
  /** Tool calls running on this connection; the idle reaper skips it while > 0. */
  inFlight: number;
}

type ConnectedMcpConnection = McpConnection & {
  status: 'connected';
  client: Client;
  transport: McpClientTransport;
};

/** A client that connected and listed its tools (startClient). */
interface StartedClient {
  client: Client;
  transport: McpClientTransport;
  rawTools: Awaited<ReturnType<Client['listTools']>>['tools'];
}

function isConnected(conn: McpConnection): conn is ConnectedMcpConnection {
  return conn.status === 'connected' && conn.client !== null && conn.transport !== null;
}

/** SDK-local error codes for a request that never got a server answer. */
const MCP_CONNECTION_CLOSED = -32000;
const MCP_REQUEST_TIMEOUT = -32001;

/**
 * True when the server itself answered with a JSON-RPC error (bad params,
 * unknown tool, …): the connection is healthy and keeps its process/browser
 * state. Timeouts, closed connections and transport failures are not.
 */
function isServerReportedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  return typeof code === 'number' && code !== MCP_CONNECTION_CLOSED && code !== MCP_REQUEST_TIMEOUT;
}

function sameConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What the MCP pane's Update did. `ok` is the install; `error` also covers a failed restart. */
interface McpUpdateResult {
  ok: boolean;
  previousVersion: string | null;
  installedVersion: string | null;
  /** The server was running, so it was restarted on the new copy. */
  restarted: boolean;
  error?: string;
}

function describeLaunch(plan: McpLaunchPlan | null): string {
  if (plan?.mode === 'direct') return `, node, installed ${plan.version}`;
  if (plan?.mode === 'npx') return `, through npx: ${plan.reason}`;
  return '';
}

class McpService {
  /** Connection map. Key: `${serverId}` (shared) or `${serverId}:${agentId}` (per-agent). */
  private connections = new Map<string, McpConnection>();
  /** Server configs hydrated from the `mcp_servers` table. */
  private configs = new Map<string, McpServerConfig>();
  /** Live tool defs per server (cache; populated on connect). Server-scoped. */
  private toolDefsByServer = new Map<string, McpToolDef[]>();
  /** namespaced tool id → { serverId, rawToolName } (call routing fast-path). */
  private toolIndex = new Map<string, { serverId: string; rawToolName: string }>();
  /**
   * Servers a connect attempt skipped for a config reason (missing credential,
   * disabled integration provider) → that reason. Background warm-ups
   * (catalog reads, per-turn tool resolution) honor it instead of re-reading
   * credentials and re-logging on every read; any config/credential/provider
   * change for the server clears it (loadConfig diff, disconnect, sync).
   */
  private skippedServers = new Map<string, string>();
  /**
   * Servers whose last start failed (command not found, crashed on init…) →
   * when background warm-ups may try again, and why it failed, so a broken
   * server is not re-spawned and re-logged on every agent turn. Cleared by
   * a successful connect and by any config/credential/provider change.
   */
  private failedServers = new Map<string, { retryAt: number; reason: string }>();
  private reaperHandle: ReturnType<typeof setInterval> | null = null;
  /** In-flight starts by connection key, so concurrent callers share one spawn. */
  private starting = new Map<string, Promise<void>>();
  /**
   * Servers the idle reaper stopped (tools still cached) — shown as 'idle',
   * not 'disconnected'. Cleared by the next successful connect and by any
   * explicit disconnect.
   */
  private idleStopped = new Set<string>();
  /** Installs `npx <pkg>` servers once and says how to start them (mcpInstaller). */
  private installer = new McpInstaller();
  /** False until the first successful loadConfig (boot), which also prunes orphaned installs. */
  private configLoaded = false;

  /**
   * Test seam: an installer with its own root and npm. The next loadConfig
   * then counts as a boot load for that root (prunes, installs nothing).
   */
  useInstaller(installer: McpInstaller): void {
    this.installer = installer;
    this.configLoaded = false;
  }

  // Connection-key helpers

  private connectionKey(serverId: string, agentId?: string): string {
    const config = this.configs.get(serverId);
    if (config?.scope !== 'per-agent') return serverId;
    return `${serverId}:${agentId ?? DEFAULT_AGENT_BUCKET}`;
  }

  private isPerAgentKey(key: string): boolean {
    return key.includes(':');
  }

  private ensureReaperStarted(): void {
    if (this.reaperHandle) return;
    this.reaperHandle = setInterval(() => this.reapIdleConnections(), REAP_INTERVAL_MS);
    this.reaperHandle.unref?.();
  }

  /**
   * Stop every connection, shared or per-agent, that has had no tool call for
   * IDLE_REAP_MS and has none running. The server's cached tools stay, so
   * agents keep seeing them; the next call starts it again.
   */
  private reapIdleConnections(): void {
    const now = Date.now();
    for (const [key, conn] of this.connections) {
      if (!isConnected(conn) || conn.inFlight > 0) continue;
      if (now - conn.lastUsedAt < IDLE_REAP_MS) continue;
      logger.info(
        `[McpService] Stopping idle ${key}: no tool call for ${Math.round(IDLE_REAP_MS / 60_000)} min`
      );
      this.idleStopped.add(conn.config.id);
      void this.closeConnection(key);
    }
  }

  private async closeConnection(key: string): Promise<void> {
    // A start under way for this key is abandoned (it closes its own client
    // when it finishes); the next connect starts afresh instead of joining it.
    this.starting.delete(key);
    const conn = this.connections.get(key);
    if (!conn) return;
    await this.retire(key, conn, { forget: true });
  }

  /**
   * Take a connection out of service and close its client — for stdio servers
   * that is what terminates the child process (e.g. Playwright + its browser).
   * The client is detached synchronously first, so the transport's onclose
   * (fired by our own close) recognizes it as intentional. Only removes the
   * pool entry while it is still this connection, never a newer one under the
   * same key. Never throws.
   */
  private async retire(key: string, conn: McpConnection, opts: { forget: boolean }): Promise<void> {
    const client = conn.client;
    conn.client = null;
    conn.transport = null;
    conn.status = 'disconnected';
    if (opts.forget && this.connections.get(key) === conn) this.connections.delete(key);
    if (client) await this.closeClient(key, client);
  }

  private async closeClient(key: string, client: Client): Promise<void> {
    try {
      await client.close();
    } catch (err: unknown) {
      logger.warn(`[McpService] Error closing ${key}: ${getErrorMessage(err)}`);
    }
  }

  /**
   * Observe a live connection's transport. `Client.connect()` already wrapped
   * the transport's callbacks with the SDK's own handlers (which reject
   * in-flight requests and reset the protocol on close), so ours chain after
   * them rather than replacing them.
   */
  private watchTransport(
    key: string,
    conn: McpConnection,
    client: Client,
    transport: McpClientTransport
  ): void {
    const sdkOnClose = transport.onclose;
    transport.onclose = () => {
      sdkOnClose?.();
      // A close we initiated (retire) already detached this client.
      if (conn.client !== client) return;
      logger.warn(`[McpService] ${key} transport closed unexpectedly`);
      conn.client = null;
      conn.transport = null;
      conn.status = 'disconnected';
      if (this.connections.get(key) === conn) this.connections.delete(key);
    };
    // A transport error is not necessarily fatal (a stray stdout line, one
    // failed SSE reconnect). A dead connection surfaces through onclose or a
    // failed request, both of which retire it with a close().
    const sdkOnError = transport.onerror;
    transport.onerror = (err: Error) => {
      sdkOnError?.(err);
      logger.error(`[McpService] ${key} transport error: ${getErrorMessage(err)}`);
    };
  }

  /** Mark a connect attempt skipped for a config reason; logs once per reason. */
  private recordSkip(serverId: string, conn: McpConnection, reason: string): void {
    conn.status = 'disconnected';
    if (this.skippedServers.get(serverId) !== reason) {
      logger.info(`[McpService] Skipping ${serverId}: ${reason}`);
    }
    this.skippedServers.set(serverId, reason);
  }

  private keysForServer(serverId: string): string[] {
    const config = this.configs.get(serverId);
    if (!config) return [];
    if (config.scope !== 'per-agent') {
      return this.connections.has(serverId) ? [serverId] : [];
    }
    const prefix = `${serverId}:`;
    return [...this.connections.keys()].filter((k) => k.startsWith(prefix));
  }

  // Config (DB-driven)

  /**
   * Load server configs from the `mcp_servers` table. Does not connect. Safe to
   * call repeatedly (e.g. after the UI adds/edits a server) — re-reads the DB.
   * A server whose config changed (or was added/removed) loses its cached skip
   * decision; an unchanged re-read is quiet.
   */
  async loadConfig(): Promise<void> {
    try {
      const { McpServers } = await import('@snaglet/db');
      const rows = await McpServers.listAll();
      const next = new Map<string, McpServerConfig>();
      for (const row of rows) next.set(row.id, rowToConfig(row));
      const changed = [...next].filter(([id, cfg]) => {
        const prev = this.configs.get(id);
        return !prev || !sameConfig(prev, cfg);
      });
      const removed = [...this.configs.keys()].filter((id) => !next.has(id));
      const firstLoad = !this.configLoaded;
      this.configs = next;
      this.configLoaded = true;
      for (const [id] of changed) this.forgetFailure(id);
      for (const id of removed) {
        this.forgetFailure(id);
        this.idleStopped.delete(id);
      }
      if (firstLoad) {
        // Boot: drop install folders of servers deleted before the restart
        // (their undo snapshot was in memory, so they can't come back).
        void this.installer
          .pruneOrphans(new Set(next.keys()))
          .catch((err: unknown) =>
            logger.warn(`[McpService] Pruning old installs failed: ${getErrorMessage(err)}`)
          );
      } else {
        // A server created, re-enabled or re-pointed at runtime installs its
        // npx package now, so its first start doesn't wait on npm. Installing
        // starts no server.
        for (const [, cfg] of changed) {
          if (cfg.enabled && cfg.transport === 'stdio') void this.installer.ensureInstalled(cfg);
        }
      }
      const summary = `[McpService] Loaded ${this.configs.size} server(s) from DB (${[...this.configs.keys()].join(', ') || 'none'})`;
      if (changed.length > 0 || removed.length > 0) logger.info(summary);
      else logger.debug(summary);
    } catch (err: unknown) {
      logger.error(`[McpService] Failed to load mcp_servers config: ${getErrorMessage(err)}`);
    }
  }

  /** Re-read config from the DB (alias for loadConfig; used after UI edits). */
  async reload(): Promise<void> {
    await this.loadConfig();
  }

  // Connect

  /**
   * Connect to a server, discover its tools, and cache them. Crash-isolated:
   * never throws — on failure the connection is marked 'disconnected'.
   */
  async connect(serverId: string, opts?: { agentId?: string }): Promise<void> {
    const config = this.configs.get(serverId);
    if (!config) {
      logger.warn(`[McpService] connect: unknown server '${serverId}'`);
      return;
    }

    // Global "installed" layer: a disabled server never connects (the enable
    // toggle in the UI is load-bearing, not cosmetic).
    if (!config.enabled) {
      logger.info(`[McpService] Skipping ${serverId}: server disabled`);
      return;
    }

    const key = this.connectionKey(serverId, opts?.agentId);
    // Single-flight: a caller arriving while this key starts waits for that
    // start instead of spawning a second process (or giving up).
    const pending = this.starting.get(key);
    if (pending) return pending;
    if (this.connections.get(key)?.status === 'connected') return;

    const start = this.open(serverId, key, config);
    this.starting.set(key, start);
    try {
      await start;
    } finally {
      if (this.starting.get(key) === start) this.starting.delete(key);
    }
  }

  /** One start of one connection key. Never throws; see connect(). */
  private async open(serverId: string, key: string, baseConfig: McpServerConfig): Promise<void> {
    let config = baseConfig;
    // Claim the key synchronously, before any await, so concurrent warm-ups of
    // the same server cannot each spawn a process.
    const conn: McpConnection = {
      client: null,
      transport: null,
      config,
      status: 'connecting',
      lastUsedAt: Date.now(),
      inFlight: 0,
    };
    this.connections.set(key, conn);

    let client: Client | null = null;
    let plan: McpLaunchPlan | null = null;
    let launchCommand = config.command;
    try {
      // Provider gate: skip if the anchoring integration provider is disabled.
      if (config.providerId) {
        const { Providers } = await import('@snaglet/db');
        const provider = await Providers.findById(config.providerId);
        if (provider?.type === 'integration' && !provider.enabled) {
          this.recordSkip(serverId, conn, 'integration provider disabled');
          return;
        }
      }

      const resolvedEnv = await resolveEnv(config);
      if (resolvedEnv === null) {
        this.recordSkip(
          serverId,
          conn,
          `missing credential (provider_id='${config.providerId ?? 'none'}')`
        );
        return;
      }

      const resolvedHeaders = await resolveHeaders(config);
      if (resolvedHeaders === null) {
        this.recordSkip(
          serverId,
          conn,
          `missing header credential (provider_id='${config.providerId ?? 'none'}')`
        );
        return;
      }

      // Bounded: the login-shell PATH lookup started at boot (stdio needs it).
      if (config.transport === 'stdio') await loginPathReady();

      // disconnect()/sync dropped this attempt while credentials resolved.
      if (this.connections.get(key) !== conn) {
        conn.status = 'disconnected';
        return;
      }

      // An `npx <pkg>` server starts from Snaglet's installed copy, installing it
      // first if it has none; otherwise it runs as configured.
      if (config.transport === 'stdio') {
        plan = await this.installer.launchFor(config, { install: true });
        if (this.connections.get(key) !== conn) {
          conn.status = 'disconnected';
          return;
        }
      }

      const direct = plan?.mode === 'direct' ? plan : null;
      if (direct) launchCommand = direct.command;
      let started: StartedClient;
      try {
        started = await this.startClient(key, config, resolvedEnv, resolvedHeaders, direct);
      } catch (err: unknown) {
        // Snaglet's installed copy didn't start. Try the configured npx command,
        // exactly as written; if that works, the copy is set aside (recorded
        // and shown in the pane): a start must never fail where npx works.
        if (!direct || this.connections.get(key) !== conn) throw err;
        const reason = `the installed copy didn't start: ${describeConnectError(config, err, direct.command)}`;
        logger.warn(`[McpService] ${key}: ${reason}; starting it through npx as configured`);
        launchCommand = config.command;
        started = await this.startClient(key, config, resolvedEnv, resolvedHeaders, null);
        plan = { mode: 'npx', reason };
        await this.installer.setAside(config, direct.version, reason);
      }
      client = started.client;
      const { transport, rawTools } = started;

      if (this.connections.get(key) !== conn) {
        // Dropped mid-connect: nobody will ever close this client but us.
        conn.status = 'disconnected';
        const orphan = client;
        client = null;
        await this.closeClient(key, orphan);
        return;
      }

      const toolDefs = buildToolDefs(serverId, rawTools);

      conn.client = client;
      conn.transport = transport;
      conn.status = 'connected';
      // The idle clock starts now, not when the (possibly long) start began.
      conn.lastUsedAt = Date.now();
      this.skippedServers.delete(serverId);
      this.failedServers.delete(serverId);
      this.idleStopped.delete(serverId);

      // Tool caches are server-scoped (per-agent connections share the toolset).
      this.toolDefsByServer.set(serverId, toolDefs);
      for (const def of toolDefs) {
        this.toolIndex.set(def.namespacedId, { serverId, rawToolName: def.rawToolName });
      }

      logger.info(
        `[McpService] Connected to ${key}: ${toolDefs.length} tools` +
          ` (${config.scope}${describeLaunch(plan)})`
      );

      this.ensureReaperStarted();

      this.watchTransport(key, conn, client, transport);
    } catch (err: unknown) {
      this.recordFailure(serverId, key, describeConnectError(config, err, launchCommand));
      conn.client = null;
      conn.transport = null;
      conn.status = 'disconnected';
      // Crash isolation — never throw. (startClient already closed a client
      // whose initialize or listTools failed.)
      if (client) await this.closeClient(key, client);
    }
  }

  /**
   * Spawn/open one client and list its tools. A failed or timed-out
   * initialize or listTools still spawned the server process, so the client
   * is closed before the error propagates — it never outlives the attempt.
   */
  private async startClient(
    key: string,
    config: McpServerConfig,
    resolvedEnv: Record<string, string>,
    resolvedHeaders: Record<string, string>,
    direct: DirectLaunch | null
  ): Promise<StartedClient> {
    const transport = buildTransport(config, resolvedEnv, resolvedHeaders, direct);
    const client = new Client(
      { name: `snaglet-${config.id}`, version: '1.0.0' },
      { capabilities: {} }
    );
    try {
      await client.connect(transport);
      const toolsResult = await client.listTools();
      return { client, transport, rawTools: toolsResult.tools ?? [] };
    } catch (err: unknown) {
      await this.closeClient(key, client);
      throw err;
    }
  }

  /**
   * Warm a server whose tools aren't known yet, without blocking: the tools
   * become available on a later turn once the connect completes. A
   * server with cached tools is left alone — stopped by the idle reaper or
   * not, agents already see its tools and a tool call starts it. Unknown,
   * disabled, config-skipped and backing-off servers are left alone too —
   * re-trying them on every read only re-reads credentials to reach the
   * same answer.
   */
  private ensureConnected(serverId: string, agentId?: string): void {
    const config = this.configs.get(serverId);
    if (!config?.enabled) return;
    if ((this.toolDefsByServer.get(serverId)?.length ?? 0) > 0) return;
    if (this.skippedServers.has(serverId)) return;
    if (this.inFailureBackoff(serverId)) return;
    const key = this.connectionKey(serverId, agentId);
    const conn = this.connections.get(key);
    if (conn?.status === 'connected' || conn?.status === 'connecting') return;
    void this.connect(serverId, { agentId }).catch((err: unknown) =>
      logger.error(
        `[McpService] Unexpected background connect failure for ${key}: ${getErrorMessage(err)}`
      )
    );
  }

  /**
   * Public, non-blocking: warm the servers an agent turn needs (those the
   * agent has enabled). Only the turn path calls this — never a listing.
   */
  ensureServersConnected(serverIds: string[], opts?: { agentId?: string }): void {
    for (const id of serverIds) this.ensureConnected(id, opts?.agentId);
  }

  // Live tool reads (cache-only, non-blocking)

  /**
   * Cached tool defs for a set of enabled servers. Cache-only: never blocks
   * and never starts a server. A server that isn't warm yet is simply absent
   * (an agent turn warms it with ensureServersConnected); a server the
   * idle reaper stopped keeps its tools here.
   */
  getToolDefsForServers(serverIds: string[]): McpToolDef[] {
    const out: McpToolDef[] = [];
    for (const id of serverIds) {
      const config = this.configs.get(id);
      // Skip unknown or globally-disabled servers (the installed layer gates
      // resolution even if an agent still lists the server).
      if (!config || !config.enabled) continue;
      const cached = this.toolDefsByServer.get(id);
      if (cached && cached.length > 0) out.push(...cached);
    }
    return out;
  }

  /** Cached tool defs for one server (empty if not warm). */
  listServerTools(serverId: string): McpToolDef[] {
    return this.toolDefsByServer.get(serverId) ?? [];
  }

  /**
   * Every cached tool def across all globally-enabled configured servers — the
   * in-app tool catalog the settings / tool-access pane lists. Server-scoped
   * only (per-agent servers surface their tools per-turn through
   * resolveAgentTools, keyed by agent). Read-only: a server that is not warm
   * is simply absent — reading the catalog never spawns a server process.
   */
  getCatalogToolDefs(): McpToolDef[] {
    const out: McpToolDef[] = [];
    for (const [id, config] of this.configs) {
      if (!config.enabled) continue;
      const cached = this.toolDefsByServer.get(id);
      // Cache-only: listing the catalog never starts a server. A server
      // spawns only when an agent that has it enabled needs it (a turn's tool
      // resolution or a tool call), so its tools appear here once one has.
      if (cached && cached.length > 0) out.push(...cached);
    }
    return out;
  }

  /** Look up a single cached tool def by its namespaced id (for tool(op:schema)). */
  getToolDef(namespacedId: string): McpToolDef | null {
    for (const defs of this.toolDefsByServer.values()) {
      const found = defs.find((d) => d.namespacedId === namespacedId);
      if (found) return found;
    }
    return null;
  }

  /** Is this id an MCP tool id we can route? */
  isMcpToolId(id: string): boolean {
    return id.startsWith(MCP_PREFIX);
  }

  /**
   * Resolve `mcp__<serverId>__<rawToolName>` → { serverId, rawToolName } by
   * matching the longest known server id (robust to tool names containing
   * `__` and to server ids that are prefixes of one another).
   */
  private parseMcpToolId(id: string): { serverId: string; rawToolName: string } | null {
    if (!id.startsWith(MCP_PREFIX)) return null;
    const rest = id.slice(MCP_PREFIX.length);
    let best: string | null = null;
    for (const serverId of this.configs.keys()) {
      if (rest.startsWith(`${serverId}__`) && (!best || serverId.length > best.length)) {
        best = serverId;
      }
    }
    if (best) return { serverId: best, rawToolName: rest.slice(best.length + 2) };
    // Fast-path for already-connected tools whose server may have been removed
    // from config mid-flight.
    const idx = this.toolIndex.get(id);
    return idx ? { serverId: idx.serverId, rawToolName: idx.rawToolName } : null;
  }

  // Call

  /**
   * Call an MCP tool by its namespaced id. Starts the server if it isn't
   * running (never started, stopped for idleness, or crashed) and waits for
   * that start — joining one already under way. Always returns — never throws
   * (crash isolation). Pass `opts.agentId` for per-agent servers so the call
   * routes to the right subprocess.
   */
  async callTool(
    namespacedToolId: string,
    params: Record<string, unknown> = {},
    opts?: { agentId?: string }
  ): Promise<McpCallResult | McpError> {
    const parsed = this.parseMcpToolId(namespacedToolId);
    if (!parsed) {
      return {
        error: 'mcp_tool_not_found',
        server: 'unknown',
        detail: `No MCP tool: ${namespacedToolId}`,
      };
    }

    const { serverId, rawToolName } = parsed;
    const key = this.connectionKey(serverId, opts?.agentId);
    let conn = this.connections.get(key);

    if (!conn || conn.status !== 'connected') {
      await this.connect(serverId, { agentId: opts?.agentId });
      conn = this.connections.get(key);
    }
    if (!conn || !isConnected(conn)) {
      const reason = this.failedServers.get(serverId)?.reason ?? this.skippedServers.get(serverId);
      return reason
        ? { error: 'mcp_server_unavailable', server: serverId, detail: reason }
        : { error: 'mcp_server_unavailable', server: serverId };
    }

    conn.lastUsedAt = Date.now();
    conn.inFlight += 1;
    const live: McpConnection = conn;
    try {
      const result = await conn.client.callTool({ name: rawToolName, arguments: params });
      return { content: result.content, isError: Boolean(result.isError) };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      logger.error(`[McpService] ${key} ${rawToolName} call failed: ${message}`);
      if (!isServerReportedError(err)) {
        // Timed out, closed, or the transport failed: the connection can't be
        // trusted, and abandoning it without close() orphans its process. The
        // entry is detached synchronously; the (slow) close runs in background.
        void this.retire(key, live, { forget: this.isPerAgentKey(key) });
      }
      return { error: 'mcp_call_failed', server: serverId, detail: message };
    } finally {
      live.inFlight -= 1;
      live.lastUsedAt = Date.now();
    }
  }

  // Introspection / lifecycle

  /** Is a given namespaced tool id backed by a known MCP server? */
  hasTool(namespacedToolId: string): boolean {
    return this.parseMcpToolId(namespacedToolId) !== null;
  }

  /**
   * Live status. 'idle': stopped by the idle reaper, tools still cached, starts
   * on the next call. 'unknown': not started since Snaglet started (or since its
   * config changed). 'disconnected': a start failed or was skipped — see
   * getStatusDetail.
   */
  getStatus(serverId: string): 'connected' | 'disconnected' | 'connecting' | 'idle' | 'unknown' {
    const config = this.configs.get(serverId);
    if (!config) return 'unknown';
    const stopped = this.idleStopped.has(serverId) ? 'idle' : 'unknown';
    if (config.scope !== 'per-agent') {
      return this.connections.get(serverId)?.status ?? stopped;
    }
    const statuses = this.keysForServer(serverId).flatMap((k) => {
      const status = this.connections.get(k)?.status;
      return status ? [status] : [];
    });
    if (statuses.length === 0) return stopped;
    if (statuses.includes('connected')) return 'connected';
    if (statuses.includes('connecting')) return 'connecting';
    return 'disconnected';
  }

  /** Why the server's last start failed or was skipped; null when it didn't. */
  getStatusDetail(serverId: string): string | null {
    return this.failedServers.get(serverId)?.reason ?? this.skippedServers.get(serverId) ?? null;
  }

  /** True when the server's env/headers reference a credential placeholder. */
  requiresCredential(serverId: string): boolean {
    const config = this.configs.get(serverId);
    if (!config) return false;
    return configRequiresCredential(config);
  }

  /**
   * The provider-credential key a server's credentials are stored under:
   * its provider id when set, else its own id. Null for unknown servers.
   */
  credentialKey(serverId: string): string | null {
    const config = this.configs.get(serverId);
    if (!config) return null;
    return credentialKeyForConfig(config);
  }

  /**
   * Describe the credential shape a server needs, derived from its env/headers
   * placeholders — `${credential}` → one opaque secret, `${cred.field}` → one
   * named bundle field each. Drives the UI's dynamic credential form (the
   * server spec is the source of truth; no separate descriptor table).
   */
  getCredentialSpec(serverId: string): { requiresSecret: boolean; bundleFields: string[] } {
    const config = this.configs.get(serverId);
    if (!config) return { requiresSecret: false, bundleFields: [] };
    return configCredentialSpec(config);
  }

  /** Per-server human-confirmation default. */
  getConfirmationPolicy(serverId: string): boolean {
    return this.configs.get(serverId)?.requiresConfirmation ?? true;
  }

  isMcpServer(serverId: string): boolean {
    return this.configs.has(serverId);
  }

  isPerAgent(serverId: string): boolean {
    return this.configs.get(serverId)?.scope === 'per-agent';
  }

  getServerNames(): string[] {
    return [...this.configs.keys()];
  }

  /**
   * One-shot connection probe for the UI "Test Connection" button. Reads the
   * server's current saved row directly and spawns a throwaway client against it,
   * lists tools, and tears it down, without mutating the live config map or the
   * connection pool. Returns a structured result because `connect()` is void
   * + crash-isolated and can't surface the failure reason on its own.
   */
  async testConnection(
    serverId: string
  ): Promise<{ ok: boolean; status: string; toolCount: number; error?: string }> {
    const { McpServers } = await import('@snaglet/db');
    const row = await McpServers.findServer(serverId);
    if (!row) {
      return { ok: false, status: 'unknown', toolCount: 0, error: `Unknown server '${serverId}'.` };
    }
    const config = rowToConfig(row);

    let resolvedEnv: Record<string, string> | null;
    try {
      resolvedEnv = await resolveEnv(config);
    } catch (err: unknown) {
      return { ok: false, status: 'error', toolCount: 0, error: getErrorMessage(err) };
    }
    if (resolvedEnv === null) {
      return {
        ok: false,
        status: 'missing_credential',
        toolCount: 0,
        error: 'Missing credential — add one before testing.',
      };
    }

    let resolvedHeaders: Record<string, string> | null;
    try {
      resolvedHeaders = await resolveHeaders(config);
    } catch (err: unknown) {
      return { ok: false, status: 'error', toolCount: 0, error: getErrorMessage(err) };
    }
    if (resolvedHeaders === null) {
      return {
        ok: false,
        status: 'missing_credential',
        toolCount: 0,
        error: 'Missing header credential — add one before testing.',
      };
    }

    let transport: McpClientTransport;
    try {
      if (config.transport === 'stdio') await loginPathReady();
      // Test what a start would run, without installing anything.
      const plan =
        config.transport === 'stdio'
          ? await this.installer.launchFor(config, { install: false })
          : null;
      transport = buildTransport(
        config,
        resolvedEnv,
        resolvedHeaders,
        plan?.mode === 'direct' ? plan : null
      );
    } catch (err: unknown) {
      return { ok: false, status: 'unsupported', toolCount: 0, error: getErrorMessage(err) };
    }

    const client = new Client(
      { name: `snaglet-test-${serverId}`, version: '1.0.0' },
      { capabilities: {} }
    );
    try {
      await client.connect(transport);
      const toolsResult = await client.listTools();
      return { ok: true, status: 'connected', toolCount: toolsResult.tools?.length ?? 0 };
    } catch (err: unknown) {
      return { ok: false, status: 'disconnected', toolCount: 0, error: getErrorMessage(err) };
    } finally {
      try {
        await client.close();
      } catch {
        /* throwaway probe — ignore close errors */
      }
    }
  }

  /** Gracefully disconnect a server and forget its cached tools and skip decision. */
  async disconnect(serverId: string): Promise<void> {
    for (const key of this.keysForServer(serverId)) {
      await this.closeConnection(key);
    }
    this.forgetFailure(serverId);
    this.idleStopped.delete(serverId);
    this.toolDefsByServer.delete(serverId);
    for (const [namespacedId, mapping] of this.toolIndex) {
      if (mapping.serverId === serverId) this.toolIndex.delete(namespacedId);
    }
    logger.info(`[McpService] Disconnected ${serverId}`);
  }

  /**
   * Reconcile after a server's config/credential/enablement or its anchoring
   * provider's enablement changed: re-read config and drop its connection(s).
   * The arg may be a server id (from the MCP routes) or a provider id (from the
   * provider enable/disable hook). For builtins these coincide, but a custom
   * server may anchor a different provider id, so this reconciles the server
   * with this exact id plus any server whose `providerId` matches it.
   */
  async syncFromProvider(idOrProviderId: string): Promise<void> {
    await this.loadConfig();
    const targets = new Set<string>();
    if (this.configs.has(idOrProviderId)) targets.add(idOrProviderId);
    for (const cfg of this.configs.values()) {
      if (cfg.providerId === idOrProviderId) targets.add(cfg.id);
    }
    // A removed server matches no config; disconnect its id anyway.
    if (targets.size === 0) targets.add(idOrProviderId);
    // Only drop the existing connection(s). The next agent that needs the
    // server reconnects it with the current config; nothing starts without one.
    for (const id of targets) await this.disconnect(id);
  }

  // Install-once (npx servers)

  /** The MCP pane's install line for a server; null for servers that don't use npx. */
  async getInstallInfo(serverId: string): Promise<McpInstallInfo | null> {
    const config = this.configs.get(serverId);
    return config ? this.installer.describe(config) : null;
  }

  /**
   * The MCP pane's Update: install the configured package again (its pinned
   * version, else the latest) into a fresh copy, then restart the server if
   * it was running so it runs that copy. A failed install leaves the current
   * copy and the server as they were. For people only: a route, not an agent op.
   */
  async updateInstall(serverId: string): Promise<McpUpdateResult> {
    await this.loadConfig();
    const config = this.configs.get(serverId);
    const none = { previousVersion: null, installedVersion: null, restarted: false };
    if (!config) return { ok: false, ...none, error: `Unknown server '${serverId}'.` };
    const pkg = this.installer.packageFor(config);
    if (!pkg.ok) return { ok: false, ...none, error: `Nothing to update: ${pkg.reason}.` };

    const outcome = await this.installer.install(config, pkg.launch, { keepOld: true });
    if (!outcome.ok) {
      return {
        ok: false,
        previousVersion: outcome.previousVersion,
        installedVersion: outcome.previousVersion,
        restarted: false,
        error: outcome.reason,
      };
    }

    const running = this.keysForServer(serverId).filter((key) => {
      const status = this.connections.get(key)?.status;
      return status === 'connected' || status === 'connecting';
    });
    for (const key of running) await this.closeConnection(key);
    await this.installer
      .pruneOld(serverId)
      .catch((err: unknown) =>
        logger.warn(
          `[McpService] Pruning old copies of ${serverId} failed: ${getErrorMessage(err)}`
        )
      );
    let restartError: string | undefined;
    for (const key of running) {
      await this.connect(serverId, { agentId: this.agentIdOfKey(serverId, key) });
      const conn = this.connections.get(key);
      if (!conn || !isConnected(conn)) {
        restartError = this.failedServers.get(serverId)?.reason ?? 'it did not start';
      }
    }
    logger.info(
      `[McpService] Updated ${serverId} to ${outcome.version}` +
        (running.length > 0 ? ` and restarted ${running.length} connection(s)` : '')
    );
    return {
      ok: true,
      previousVersion: outcome.previousVersion,
      installedVersion: outcome.version,
      restarted: running.length > 0,
      ...(restartError
        ? { error: `Installed ${outcome.version}, but the server didn't restart: ${restartError}` }
        : {}),
    };
  }

  /**
   * Delete a deleted server's install folder once its delete is past undo,
   * unless a server with that id exists again. Never throws.
   */
  async removeInstall(serverId: string): Promise<void> {
    await this.loadConfig();
    if (this.configs.has(serverId)) return;
    try {
      await this.installer.remove(serverId);
    } catch (err: unknown) {
      logger.warn(
        `[McpService] Removing the install of ${serverId} failed: ${getErrorMessage(err)}`
      );
    }
  }

  private agentIdOfKey(serverId: string, key: string): string | undefined {
    return key === serverId ? undefined : key.slice(serverId.length + 1);
  }

  async shutdown(): Promise<void> {
    logger.info('[McpService] Shutting down all MCP connections...');
    if (this.reaperHandle) {
      clearInterval(this.reaperHandle);
      this.reaperHandle = null;
    }
    const closePromises: Promise<void>[] = [];
    for (const [key, conn] of this.connections) {
      if (conn.client) {
        closePromises.push(
          this.retire(key, conn, { forget: false }).then(() => {
            logger.info(`[McpService] ${key} closed`);
          })
        );
      }
    }
    await Promise.allSettled(closePromises);
    this.connections.clear();
    this.toolDefsByServer.clear();
    this.toolIndex.clear();
    this.skippedServers.clear();
    this.failedServers.clear();
    this.idleStopped.clear();
    this.starting.clear();
  }

  // Start-failure backoff

  /** Record a failed start; log it once per distinct reason, not per retry. */
  private recordFailure(serverId: string, key: string, reason: string): void {
    const previous = this.failedServers.get(serverId);
    this.failedServers.set(serverId, { retryAt: Date.now() + CONNECT_RETRY_BACKOFF_MS, reason });
    if (previous?.reason === reason) {
      logger.debug(`[McpService] ${key} still failing: ${reason}`);
    } else {
      logger.error(`[McpService] Failed to connect to ${key}: ${reason}`);
    }
  }

  private inFailureBackoff(serverId: string): boolean {
    const failure = this.failedServers.get(serverId);
    return failure !== undefined && Date.now() < failure.retryAt;
  }

  /** Forget cached skip/failure decisions so the next agent re-checks the server. */
  private forgetFailure(serverId: string): void {
    this.skippedServers.delete(serverId);
    this.failedServers.delete(serverId);
  }
}

// Singleton
export const mcpService = new McpService();
