// Must stay the first import: env files (SNAGLET_HOME, LOG_LEVEL, ...) have to be
// in process.env before any module below reads configuration at import time.
import '@server/config/environment';
import { createServer } from 'http';
import express, { Express } from 'express';
import cors from 'cors';
import { buildAllowedOrigins, corsOriginCheck } from '@server/config/corsOrigins';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getErrorMessage } from '@snaglet/shared/utils';
// Domain routes
import agentsRoutes from '@server/domains/agents/agents.routes';
import threadsRoutes from '@server/domains/threads/threads.routes';
import toolsRoutes from '@server/domains/tools/tools.routes';

// Additional domain routes
import memoriesRoutes from '@server/domains/memories/memories.routes';
import linksRoutes from '@server/domains/links/links.routes';
import userProfileRoutes from '@server/domains/user-profile/user-profile.routes';
import imagesRoutes from '@server/domains/images/images.routes';
import calendarRoutes from '@server/domains/calendar/calendar.routes';
import remindersRoutes from '@server/domains/reminders/reminders.routes';
import { reminderScheduler } from '@server/domains/reminders/reminderScheduler';
import projectsRoutes from '@server/domains/projects/projects.routes';
import filesRoutes from '@server/domains/files/files.routes';
import containersRoutes from '@server/domains/containers/containers.routes';
import docsRoutes from '@server/domains/docs/docs.routes';
import cloneRoutes from '@server/domains/clone/clone.routes';
import membersRoutes from '@server/domains/members/members.routes';
import mcpGatewayRoutes from '@server/domains/mcp/mcp.routes';
import mcpApiKeysRoutes from '@server/domains/mcp/mcpApiKeys.routes';

// Infrastructure & standalone routes
import apiRoutes from '@server/routes/api';
import chatRoutes from '@server/routes/chat';
import voiceRoutes from '@server/routes/voice';
import providersRoutes from '@server/routes/providers';
import mcpRoutes from '@server/routes/mcp';
import healthRoutes from '@server/routes/health';
import computerRoutes from '@server/routes/computer';
import browserRoutes from '@server/routes/browser';
import serverRoutes, { configureServerShutdown } from '@server/routes/server';
import dbRoutes from '@server/routes/db';
import modelsRoutes from '@server/routes/models';
import embeddingsRoutes from '@server/routes/embeddings';
import rerankRoutes from '@server/routes/rerank';
import databaseSetupRoutes from '@server/routes/database-setup';
import paletteSearchRoutes from '@server/routes/palette-search';
import settingsRoutes from '@server/routes/settings';
import workersRoutes from '@server/routes/workers';
import hooksRoutes from '@server/routes/hooks';
import skillsRoutes from '@server/routes/skills';
import notificationsRoutes from '@server/routes/notifications';
import featureFlagsRoutes from '@server/routes/featureFlags';
import tablesRoutes from '@server/routes/tables';

import schedulesRoutes from '@server/routes/schedules';
import automationsRoutes from '@server/routes/automations';
import runsRoutes from '@server/routes/runs';
import adminEmbeddingsRoutes from '@server/routes/admin-embeddings';
import adminDbRoutes from '@server/routes/admin-db';
import { snagletHomeRouter } from '@server/routes/snagletHome.route';
import { wsService } from '@server/services/WebSocketService';
import {
  registerBrowserEmotionSink,
  startCursorEmotionService,
} from '@server/services/CursorEmotionService';
import { setBrowserEmotion } from '@server/services/BrowserController';
import { initUiSurface } from '@server/realtime/surfaces/ui';
import { initSettingsSurface } from '@server/realtime/surfaces/settings';
import { socketService } from '@server/services/SocketService';
import { archiveTtlSweeper } from '@server/services/ArchiveTtlSweeper';
import { updateCheckService } from '@server/services/UpdateCheckService';
import archiveRoutes from '@server/routes/archive';
import exportRoutes from '@server/routes/export';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { ensureSnagletHome } from '@server/services/snagletHome';
import { RERANKER_FETCH_HINT } from '@server/services/reranking/LocalRerankerService';
import { bootstrapLocalReranker } from '@server/services/reranking/RerankerBootstrap';
import { EMBEDDER_FETCH_HINT } from '@server/services/embedding/LocalEmbedderService';
import { bootstrapLocalEmbedder } from '@server/services/embedding/EmbeddingBootstrap';
import { serverConfig } from './config';
import { initializeDatabase, closeDatabase, getDbClient } from '@snaglet/db';
import { ensureBuiltinCatalog } from '@snaglet/db/migrations';
import { getSchemaFormatVersion } from '@snaglet/db/db';
import { Users } from '@snaglet/db/tables/users';
import { reconcileProjectFolderSymlinks } from '@server/services/projectFolder';

/** Fallback when npm_package_version isn't injected (bundled binary). */
const SERVER_VERSION = '1.0.0';
import { Runs } from '@snaglet/db/tables/runs';

import copilotAuthRoutes from '@server/auth/copilot';
import { errorHandler, notFoundHandler, apiRateLimiter } from '@server/middleware';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import {
  startCustomToolScanner,
  stopCustomToolScanner,
} from '@server/services/ToolService/customTools/CustomToolScanner';
import {
  startHookScanner,
  stopHookScanner,
} from '@server/services/customHooks/HookRegistryService';
import { startSkillScanner, stopSkillScanner } from '@server/services/skills/SkillRegistryService';
import { resolveLoginShellPath } from '@server/services/ToolService/lib/loginShellPath';
import {
  preMigrationBackupIfNeeded,
  pruneAutomaticSnapshots,
} from '@server/services/DatabaseBackupService';
import { requestLogger } from '@server/middleware/requestLogger';
import { jsonBody } from '@server/middleware/jsonBody';
import { sidecarAuthMiddleware, shouldWarnOpenAuth } from '@server/middleware/sidecarAuth';
import { actorContextMiddleware } from '@server/middleware/actorContext';
import { logger } from './config/logger';
import { createSafetyNetReporter } from './config/processSafetyNets';
import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';
import { isConversationCompactionEnabled } from '@server/config/conversationCompactionPolicy';
import { startEmbeddingWorker, stopEmbeddingWorker } from './workers/EmbeddingWorker';
import { registerNotificationHooks } from './services/notificationHooks';
import { dismissStaleAskNotifications } from './services/askNotifications';
import { killAllShellSessions } from '@server/services/ToolService/tools/shell/codex-shell-sessions';
import { startRunReaper, stopRunReaper } from '@server/services/RunReaperService';
import { subagentService } from '@server/services/subagents/SubagentService';
import { shellJobService } from '@server/services/shellJobs/ShellJobService';
import {
  cleanupStartupMessageEmbeddings,
  ensureStartupEmbeddingBackfill,
} from '@server/services/EmbeddingMaintenanceService';
import { startFileIndexing, stopFileIndexing } from './services/fileIndexing';
import { scheduleService } from './services/ScheduleService';
import { registerActorMemberResolver } from '@server/realtime/actorMember';
import { purgeReleasedTableData } from '@server/domains/tables/tableHistory';
import { dropPinnedPinkDefaults } from '@server/services/settings/appearanceColorsCleanup';
import { keepSavedThemeOnNewDefault } from '@server/services/settings/appearanceKeepSavedTheme';
import { ensureWorkspaceId } from '@server/services/workspaceId';
import { enableExistingTablesOnce } from '@server/services/tableSemantic/defaultOn';
import { ensureAppleOnDeviceCredential } from '@server/services/ProviderChatService/appleChat/ensureAppleOnDeviceCredential';
import { seedOnboardingOnce } from '@server/services/onboarding/seedOnboarding';
import { seedEnvironmentTestCredentials } from '@server/services/ProviderCredentialService';
import { visionRoutes } from '@server/domains/vision/vision.routes';
import { visionThreadService } from '@server/services/vision/VisionThreadService';
import { ProcessShutdownCoordinator } from '@server/services/ProcessShutdownCoordinator';
import { systemCursorOverlayLauncher } from '@server/services/systemCursorOverlayLauncher';
import { shutdownVoiceEngine } from '@server/services/SocketService/voiceSession/engineAdapter';
import { claudeCodeLoginService } from '@server/services/ClaudeCodeAuthService';
import { abortThread } from '@server/services/SocketService/abortStore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();
const isDevelopment: boolean = serverConfig.nodeEnv === 'development';
let acceptingRequests = true;

// Trust proxy when behind reverse proxy/load balancer
// Set to number of hops or true for all proxies (consult deployment docs)
if (!isDevelopment) {
  app.set('trust proxy', 1);
}

// Middleware. CORS is an ALLOWLIST (see corsOrigins): the local UI, the desktop
// webview, and same-origin/native callers only — never `origin: true`, which
// let any website the user visited read the local API's responses. No
// `credentials: true`: auth is header-based (Authorization / snaglet_token), not
// cookies, so credentialed CORS is unnecessary and only widens exposure.
const allowedOrigins = buildAllowedOrigins();
app.use(cors({ origin: corsOriginCheck(allowedOrigins) }));
app.use(jsonBody);
app.use((req, res, next) => {
  if (!acceptingRequests && req.path !== '/api/server/shutdown' && req.path !== '/health') {
    res.status(503).json({ error: 'Snaglet is shutting down' });
    return;
  }
  next();
});

// Throttle the whole API surface. Mounted before the domain routers below so
// destructive routes (/api/server, /api/admin/db) are covered — they
// are registered ahead of the catch-all /api mount and would otherwise bypass
// the limiter entirely. Health/monitoring polling stays exempt (mounted above).
app.use('/api', apiRateLimiter);

// Request logging (logs all HTTP requests)
app.use(requestLogger);

// Sidecar session-token auth — no-op unless SNAGLET_AUTH_TOKEN is set
// by the desktop shell. Protects /api on the loopback port; /health and
// static assets stay open. WebSocketService enforces the same token.
app.use(sidecarAuthMiddleware);

// Health check routes (no auth, no rate limiting)
app.use('/health', healthRoutes);
app.use('/api/database-setup', databaseSetupRoutes);
app.use('/api/snaglet-home', snagletHomeRouter);
app.use('/api/computer', computerRoutes);
app.use('/api/browser', browserRoutes);

app.use(actorContextMiddleware);

// External MCP server surface — top-level on purpose (not /api: that prefix
// carries the MCP *client* manager at /api/mcp). Guarded by its own Bearer
// API-key auth (mcpAuth), independent of sidecarAuthMiddleware's /api scope.
app.use('/mcp', mcpGatewayRoutes);

// Copilot device code flow routes (always available)
app.use('/api/auth/copilot', copilotAuthRoutes);

// Dashboard monitoring + domain routers. The global /api token bucket above
// always skips direct loopback requests, so the local desktop/browser UI can
// never lock itself out; deliberately forwarded/remote callers remain limited.
app.use('/api/server', serverRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/workers', workersRoutes);
app.use('/api/agents', agentsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/images', imagesRoutes);
app.use('/api/vision', visionRoutes);
app.use('/api/providers', providersRoutes);
app.use('/api/mcp', mcpRoutes);
app.use('/api/mcp-keys', mcpApiKeysRoutes);
app.use('/api/db', dbRoutes);
app.use('/api/tables', tablesRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/reminders', remindersRoutes);
app.use('/api/threads', threadsRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/hooks', hooksRoutes);
app.use('/api/skills', skillsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/feature-flags', featureFlagsRoutes);

app.use('/api/schedules', schedulesRoutes);
app.use('/api/automations', automationsRoutes);
app.use('/api/runs', runsRoutes);
app.use('/api/models', modelsRoutes);
app.use('/api/memories', memoriesRoutes);
app.use('/api/embeddings', embeddingsRoutes);
app.use('/api/rerank', rerankRoutes);
app.use('/api/search/palette', paletteSearchRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/containers', containersRoutes);
app.use('/api/docs', docsRoutes);
app.use('/api/clone', cloneRoutes);
app.use('/api/members', membersRoutes);
app.use('/api/user-profile', userProfileRoutes);
app.use('/api/links', linksRoutes);
app.use('/api/archive', archiveRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/admin/embeddings', adminEmbeddingsRoutes);
app.use('/api/admin/db', adminDbRoutes);

// API routes (rate limiting is applied globally to /api above).
app.use('/api', apiRoutes);

// API 404 handler - must come before SPA catch-all. Deliberately a bare
// `/api` prefix, not a wildcard path pattern (e.g. `/api/{*splat}`): the
// installed router is Express 4.22.1 / path-to-regexp 0.1.x, which doesn't
// understand Express 5's `{*splat}` grouped-wildcard syntax — that pattern
// silently fails to match anything, so every unmatched /api/* request used
// to fall through to Express's own default 404 (an HTML "Cannot POST ..."
// page) instead of this JSON handler. A plain prefix needs no special syntax
// at all: mounted here, after every real /api/* router above, it only ever
// runs when none of them matched (each one calls `next()` on a miss), so it
// naturally acts as the /api catch-all via normal middleware fall-through.
app.use('/api', notFoundHandler);

// Serve static files in production. Resolution order:
//   1. SNAGLET_WEB_STATIC_DIR env (desktop shell / ops override)
//   2. static/web next to the entry module — the bundled layout
//      (dist/bundle/static/web, staged by scripts/bundle.mjs)
//   3. the repo-relative path of a tsc build (dist/server/…)
const webStaticPath =
  process.env.SNAGLET_WEB_STATIC_DIR ??
  [path.join(__dirname, 'static/web'), path.join(__dirname, '../../../../static/web')].find((p) =>
    fs.existsSync(p)
  ) ??
  path.join(__dirname, '../../../../static/web');
// An explicit SNAGLET_WEB_STATIC_DIR means "serve this UI" regardless of env —
// the e2e scratch server boots in development (test zeroes the port) but
// must serve the built UI same-origin. Dev default stays UI-via-Vite.
if (!isDevelopment || process.env.SNAGLET_WEB_STATIC_DIR) {
  app.use(express.static(webStaticPath));

  // Only serve the SPA shell for browser navigations, not asset/file requests.
  // Deliberately the bare Express-4 catch-all `'*'`, not a wildcard path
  // pattern (e.g. `/{*splat}`): the installed router is Express 4.22.1 /
  // path-to-regexp 0.1.x, which doesn't understand Express 5's `{*splat}`
  // grouped-wildcard syntax — that pattern silently fails to match anything
  // (it compiles to a regex requiring a literal `{`/`}` in the URL), so every
  // browser deep-link / hard-refresh (e.g. GET /some/deep/route) would fall
  // through past this handler instead of getting the SPA shell. `'*'` is the
  // classic Express-4 idiom for "match every path" and needs no special
  // syntax at all. The /api 404 handler above (notFoundHandler) relies on the
  // same idiom for the same reason.
  app.get('*', (req, res, next) => {
    const hasFileExtension = path.extname(req.path) !== '';
    const prefersHtml = req.accepts('html');

    if (hasFileExtension || !prefersHtml) {
      return next();
    }

    res.sendFile(path.join(webStaticPath, 'index.html'));
  });
}

// Global error handler (must be last)
app.use(errorHandler);

/**
 * Slow, non-serving boot init — runs in the background after `httpServer.listen()`.
 *
 * Nothing here is needed to answer the UI's first `/api/*` calls (those need
 * only the DB, which is ready before `listen()`), so deferring it opens the
 * dev port in ~1-2s instead of several seconds — the `pnpm dev` Vite proxy no
 * longer floods with ECONNREFUSED. Every route that touches these subsystems
 * already degrades gracefully until they finish: the tool executor and MCP
 * gateway lazy-load the registry, `/api/tools` reads the DB, MCP client routes
 * self-load their config, and embedding/vector routes report "not ready".
 *
 * Each step keeps its own error handling and is individually best-effort — a
 * failure degrades one subsystem, it never crashes the already-listening
 * server. Order within a step still matters:
 * `toolRegistry.load()` before `syncToDatabase()`; the custom-tool scanner
 * after that sync; `mcpService.loadConfig()` before any agent turn resolves MCP tools.
 *
 * Cancellability: every start here has a matching stop/shutdown hook in
 * `gracefulShutdown`, and those are already no-ops when their start hasn't run
 * (the RUN_BACKGROUND_WORKERS=false path relies on exactly that), so a shutdown
 * that lands mid-init stays clean and never blocks on a deferred start.
 */
async function runBackgroundInit(): Promise<void> {
  const automaticLocalIntelligence = isAutomaticLocalIntelligenceEnabled();
  if (automaticLocalIntelligence) {
    // Ensure the local reranker model exists at boot — a missing/wiped
    // ~/.snaglet/models install auto-reseeds instead of just warning. Skipped
    // while the `reranker` feature flag is off. Fire-and-forget so it never
    // delays startup.
    void bootstrapLocalReranker().catch((err) =>
      logger.warn(
        `[reranker] bootstrap failed: ${getErrorMessage(err)}. Opening-retrieval reranking ` +
          `stays unavailable until the model is installed. ${RERANKER_FETCH_HINT}`
      )
    );
  }

  void bootstrapLocalEmbedder().catch((err) =>
    logger.warn(
      `[embedder] bootstrap failed: ${getErrorMessage(err)}. Embedding + vector search ` +
        `stay unavailable until the model is installed. ${EMBEDDER_FETCH_HINT}`
    )
  );

  // apple-on-device: auto-connect (empty-secret credential row) once the
  // sidecar is confirmed usable, so it shows up connected with zero user
  // action — see ensureAppleOnDeviceCredential's doc comment for why this
  // lives here (fire-and-forget, non-fatal) instead of a route-level bypass.
  void ensureAppleOnDeviceCredential();

  // A new install gets its starter content (guides, tables, threads, the
  // starter agents' docs) once. A no-op on any database that is not brand
  // new; never throws.
  void seedOnboardingOnce();

  // Mark any runs left in 'running' state as failed (interrupted by previous
  // restart). Best-effort now that it runs post-`listen()` — a failure must not
  // take down the already-serving process.
  try {
    const interrupted = await Runs.markAllRunningFailed('Server restart');
    if (interrupted > 0) logger.info(`Marked ${interrupted} interrupted run(s) as failed`);
  } catch (err: unknown) {
    logger.warn(`[startup] markAllRunningFailed failed (non-fatal): ${getErrorMessage(err)}`);
  }
  // Their pending asks (tool prompts, Triage questions) went with them: clear
  // the notifications that announced them. Never throws.
  await dismissStaleAskNotifications();

  // Zombie-run failsafe (guardrail-3): force-ends runs with zero progress.
  // Unconditional — runs are per-process (in-memory tracker), so every server
  // that dispatches runs needs its own reaper, workers flag or not.
  startRunReaper();

  // Subagent helpers: run-end listener, cleanup sweep, and recovery of
  // helpers a restart interrupted. Per process, like the reaper.
  subagentService.init();

  // Background shell jobs: completion reports to their agents, the archive /
  // delete kill, and recovery of jobs a restart cut off. Per process.
  shellJobService.init();

  // Master switch for this server's background jobs (archive sweeper,
  // embedding worker). Defaults ON; set RUN_BACKGROUND_WORKERS=false for a
  // worker-less client — e.g. a second server sharing one external Postgres,
  // where only the primary should own the background jobs.
  const runBackgroundWorkers = process.env.RUN_BACKGROUND_WORKERS !== 'false';
  if (!runBackgroundWorkers) {
    logger.info(
      'Background workers disabled (RUN_BACKGROUND_WORKERS=false) — no archive sweeper or embedding worker on this server'
    );
  }

  // Compaction kill switch: surface it at boot so a disabled flag is visible
  // before the first Compact request bounces with a socket:error.
  if (!isConversationCompactionEnabled()) {
    logger.info(
      'Conversation compaction disabled (COMPACT_CONVERSATIONS=false) — no automatic, backfill, or manual thread summaries on this server'
    );
  }

  await cleanupStartupMessageEmbeddings().catch((err) =>
    logger.warn(`[embedding] startup message cleanup failed: ${getErrorMessage(err)}`)
  );

  if (runBackgroundWorkers) {
    // Durable user schedules. One worker owner claims occurrences through the
    // database ledger; mechanical jobs never invoke a model unless their
    // explicit action is an agent message.
    scheduleService.start();
    // Periodically hard-deletes expired archived nodes.
    archiveTtlSweeper.start();
    // Daily GitHub-release update check → app_update notification.
    updateCheckService.start();
    // Calendar reminders: delivers `reminder:due` as each one fires.
    reminderScheduler.start();
    // Keeps settled-edit logging alive on every worker owner. Embedding and
    // agent-summary backfill run only after local-intelligence opt-in.
    startEmbeddingWorker();
    registerNotificationHooks();
    // One-shot opt-in background re-embed. Backfills only missing nodes, so it
    // is restart-resumable and a no-op once the corpus is embedded.
    if (automaticLocalIntelligence) {
      void ensureStartupEmbeddingBackfill().catch((err) =>
        logger.warn(`[embedding] startup backfill failed: ${getErrorMessage(err)}`)
      );
    }
    // Watches opted-in project folders and indexes their files for RAG.
    startFileIndexing();
  }

  // Load tool registry (auto-discovers all tool handlers). Non-fatal: the
  // executor + MCP gateway lazy-load it on first use and `/api/tools` reads the
  // DB, so an unloaded registry degrades to an empty/DB-backed list, never a
  // crash. (`load()` is idempotent + concurrent-safe, so a lazy-load racing this
  // one shares the same promise.)
  try {
    await toolRegistry.load();
    logger.info(`Tool registry loaded: ${toolRegistry.size} tools`);

    const { synced, errors } = await toolRegistry.syncToDatabase();
    logger.info(`Tool registry synced to DB: ${synced} tools`);
    if (errors.length > 0) {
      logger.warn(
        `[tool-registry] Sync completed with ${errors.length} issue(s): ${errors.join('; ')}`
      );
    }
  } catch (err: unknown) {
    logger.error(`[tool-registry] load/sync failed (non-fatal): ${getErrorMessage(err)}`);
  }

  // Custom folder-drop tools: scan `<snaglet-home>/tools/*` for user-authored tools
  // (definition.json + tool.ts), build + register them, and keep watching for
  // changes. Runs after the builtin registry sync (whose prune pass only touches
  // `builtin` rows, leaving these `external` rows alone). Best-effort — a bad
  // folder is logged and skipped, never fatal to boot.
  await startCustomToolScanner().catch((err) =>
    logger.warn(`[custom-tools] scanner start failed: ${getErrorMessage(err)}`)
  );

  // User-defined lifecycle hooks: scan `<snaglet-home>/hooks/*` and subscribe them to
  // the internal event bus. Deliberately not awaited — unlike the tool scanner,
  // building/describing hook folders must never gate anything, so a
  // pathological folder can't hang init (each build + describe + run is
  // independently time-bounded). Fire-and-forget; startHookScanner swallows errors.
  void startHookScanner();
  // Skills: index SKILL.md folders under ~/.snaglet/skills. Never throws.
  void startSkillScanner();
  // Agent shells get the user's login-shell PATH (node, pnpm, Homebrew…), not launchd's.
  void resolveLoginShellPath();

  // MCP servers — load config from the mcp_servers table only. No server is
  // started at boot: every server (shared or per-agent) starts lazily when an
  // agent that has it enabled needs it. Tools are discovered live and cached.
  {
    const { mcpService } = await import('@server/services/McpService/index');
    try {
      await mcpService.loadConfig();
      logger.info('MCP initialized: config loaded; servers start when an agent needs them');
    } catch (err: unknown) {
      // Crash-isolated: log but don't kill the server
      logger.error(`MCP initialization failed (non-fatal): ${getErrorMessage(err)}`);
    }
  }
}

async function startServer() {
  // First-run scaffold: ensure the ~/.snaglet config directory and its required
  // layout (e.g. the projects root) exist before anything reads or writes them.
  await ensureSnagletHome();

  // Vision sessions are process-owned and temporary. A crash cannot run the
  // normal stop hook, so remove abandoned directories before the server opens
  // a port and can accept a new access session. The cached camera binary lives
  // under .runtime and is intentionally excluded.
  await visionThreadService
    .cleanupAbandonedSessions()
    .catch((err: unknown) =>
      logger.warn(`[vision] abandoned-session cleanup failed: ${getErrorMessage(err)}`)
    );

  visionThreadService.startExpirySweep();

  // DB essentials — the only init the first UI calls (/api/providers,
  // /api/user-profile) need, and the schema every route assumes. These must
  // finish before we serve, so they stay ahead of `listen()`; a failure here is
  // fatal. Everything slower and non-serving (embedder download, tool esbuild,
  // MCP connect, hook scan, background workers) is deferred to
  // `runBackgroundInit()` after `listen()` so the port opens in ~1-2s.
  try {
    // Snapshot before any pending schema change (the update-failure lifeline).
    // No-op when the active PostgreSQL database is fresh or already up to date.
    const preMigration = await preMigrationBackupIfNeeded();
    if (preMigration) {
      logger.info('Pre-migration snapshot taken', { id: preMigration.id });
    }
    await initializeDatabase();
    logger.info('Database initialized successfully');
    // Migrations succeeded, so older automatic snapshots can go. Housekeeping
    // only: a failed prune never blocks boot.
    await pruneAutomaticSnapshots({ justTaken: preMigration }).catch((err: unknown) =>
      logger.warn(`[db-backup] automatic snapshot prune failed: ${getErrorMessage(err)}`)
    );

    // Boot invariant: the builtin catalog (providers/models/mcp_servers) must
    // be present before anything below resolves a catalog row — the local
    // reranker/embedder status checks and MCP config load in `runBackgroundInit`
    // all do. `initializeDatabase()` above already reseeds a truly fresh
    // database; this additionally heals a catalog row lost out of band on an
    // already-provisioned database (e.g. deleted directly, not via a clean-slate
    // reset), which nothing else retries. Idempotent — a no-op when the catalog
    // is already intact. Skips itself (with a warning) when migrations are
    // pending, so it never runs seed SQL against a schema shape it doesn't match.
    const db = await getDbClient();
    await ensureBuiltinCatalog(db);
    await reconcileProjectFolderSymlinks();

    await Users.getOrCreateLocalUser();

    // A database with no workspace id (a new one, or one from before the
    // setting) gets one before any window can read it; windows stamp it on
    // the pane layout they save. Never fails boot.
    await ensureWorkspaceId().catch((err: unknown) =>
      logger.warn(
        `[workspace] could not make the workspace id (non-fatal): ${getErrorMessage(err)}`
      )
    );

    const credentialSeed = await seedEnvironmentTestCredentials();
    if (credentialSeed.created > 0 || credentialSeed.updated > 0) {
      logger.info(
        `[provider-credentials] imported ${credentialSeed.created} new and ` +
          `${credentialSeed.updated} updated test credential(s) from the environment`,
        {
          providers: credentialSeed.providers,
          sourceEnvVars: credentialSeed.sourceEnvVars,
          primaryAssigned: credentialSeed.primaryAssigned,
        }
      );
    }

    // Attribution stamps (created_by / last_edited_by) resolve the ambient
    // actor to its members.id at the model write chokepoints — wire the
    // resolver (synchronous) before `listen()` so it is in place before any
    // request can trigger a doc/container write.
    registerActorMemberResolver();

    // Deleted table data whose undo step left the history (e.g. a purge that
    // failed before a restart) is dropped now; it never fails boot.
    void purgeReleasedTableData();

    // Theme colors an older Reset saved at the old pink defaults go, so those
    // tokens follow today's defaults. Once per install (a marker setting
    // records it; a failed run retries next boot). Before listen() so the
    // first theme read sees it; cheap, and it never fails boot.
    await dropPinnedPinkDefaults().catch((err: unknown) =>
      logger.warn(`[settings] theme reset cleanup failed (non-fatal): ${getErrorMessage(err)}`)
    );

    // The default theme turned dark (Soft Pastel Garden): a customized theme
    // gets the previous default saved for the colors it left unset, so it
    // looks exactly as before; one holding only old defaults follows the new
    // default. Once per install, after the cleanup above; never fails boot.
    await keepSavedThemeOnNewDefault().catch((err: unknown) =>
      logger.warn(
        `[settings] keeping the saved theme across the default change failed (non-fatal): ${getErrorMessage(err)}`
      )
    );

    // Search by meaning is on by default for custom tables up to 10,000 rows:
    // tables made before that default get it now, unless a person turned it
    // off. Once per install (a marker setting; a failed run retries next boot).
    // Before listen() so no request can turn a table off mid-run; settings
    // only (the worker builds vectors later), and it never fails boot.
    await enableExistingTablesOnce().catch((err: unknown) =>
      logger.warn(
        `[table-semantic] default-on backfill failed (non-fatal, retried next boot): ${getErrorMessage(err)}`
      )
    );
  } catch (error) {
    logger.error(`Database initialization failed: ${getErrorMessage(error)}`, {
      stack: error instanceof Error ? error.stack : undefined,
    });
    await shutdownCoordinator.request('STARTUP_FAILURE', 'exit', 1);
    return;
  }

  const httpServer = createServer(app);

  // Attach WebSocket + socket handlers to the HTTP server
  wsService.attach(httpServer);
  registerBrowserEmotionSink(setBrowserEmotion);
  startCursorEmotionService();
  initUiSurface();
  initSettingsSurface();
  socketService.init();

  // Bind loopback by default so the API is not reachable from other hosts on
  // the network (the auth token is off for local single-user use). Set
  // SNAGLET_BIND_HOST=0.0.0.0 to deliberately expose it — pair that with
  // SNAGLET_AUTH_TOKEN (see the warning below).
  const bindHost = process.env.SNAGLET_BIND_HOST?.trim() || '127.0.0.1';
  httpServer.listen(serverConfig.port, bindHost, () => {
    logger.info(`Server running on ${bindHost}:${serverConfig.port}`);
    if (shouldWarnOpenAuth(isDevelopment)) {
      logger.warn(
        'SECURITY: SNAGLET_AUTH_TOKEN is not set and NODE_ENV is not development. ' +
          'The server accepts every request with no authentication. This is fine ' +
          'for local single-user use, but if this server is reachable by anything ' +
          'other than you (e.g. bound to a public interface), set SNAGLET_AUTH_TOKEN to ' +
          'require a session token.'
      );
    }
    // Reproducible version stamp: one line carrying every version
    // a support thread needs (also surfaced by /health/metrics consumers).
    logger.info(
      `Version stamp: server=${process.env.npm_package_version ?? SERVER_VERSION} ` +
        `schemaFormat=${getSchemaFormatVersion()} node=${process.version}`
    );
    logger.info(`Mode: ${serverConfig.nodeEnv}`);
    logger.info(`API Base URL: ${serverConfig.apiBaseUrl}`);
    if (!isDevelopment) {
      logger.info(`Static files served from: ${webStaticPath}`);
    }

    // Port is open — the UI's first calls can land. Kick off the slow,
    // non-serving init now (fire-and-forget); routes degrade gracefully until
    // it completes. `runBackgroundInit` guards each step, so this only rejects
    // on a bug — log it rather than leaving an unhandled rejection.
    void runBackgroundInit().catch((err: unknown) =>
      logger.error(`[startup] background init crashed: ${getErrorMessage(err)}`)
    );
  });

  // Fail loud on a port collision instead of silently moving. Dev uses fixed
  // ports (see config.ts applyDefaultDevPorts); prod binds an OS-assigned port
  // (0) that cannot collide, so this only ever fires in dev.
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        `Port ${serverConfig.port} is already in use. Snaglet does not auto-switch ports in dev.\n` +
          `Another Snaglet server (or another process) is likely already running on ${serverConfig.port}.\n` +
          `Stop that process, or set PORT (and CLIENT_PORT for the UI) in this ` +
          `checkout's .env.local to free ports.`
      );
      process.exit(1);
    }
    throw err;
  });
}

// Parent watchdog — when launched as a desktop sidecar the shell
// passes its own PID via SNAGLET_PARENT_PID. If the shell dies without a clean
// shutdown (force-quit, crash), the sidecar must not linger as an orphan:
// poll the parent every 5s and run the normal graceful shutdown when it
// disappears. signal 0 = liveness probe, no actual signal delivered.
function startParentWatchdog(): void {
  const raw = process.env.SNAGLET_PARENT_PID;
  if (!raw) return;
  const parentPid = Number(raw);
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    logger.warn(`[watchdog] SNAGLET_PARENT_PID is not a valid pid: ${raw}`);
    return;
  }
  logger.info(`[watchdog] monitoring parent pid ${parentPid} — exiting if it disappears`);
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      logger.warn(`[watchdog] parent pid ${parentPid} gone — shutting down sidecar`);
      clearInterval(timer);
      void gracefulShutdown('PARENT_EXIT');
    }
  }, 5_000);
  timer.unref();
}
startParentWatchdog();

// Graceful shutdown: exits (or hands control back to nodemon) immediately,
// even with agent runs in flight. Interrupted runs are cheap: the next boot's
// `markAllRunningFailed('Server restart')` marks them failed, and background
// sweeps resume after a restart, so waiting for a drain gains nothing.

async function cleanupForShutdown(signal: string) {
  logger.info(`${signal} received, shutting down gracefully`);
  try {
    acceptingRequests = false;
    wsService.stopAcceptingConnections();
    activeRunTracker.stopAcceptingSessions();
    // Stop producers before asking in-flight work to drain: their timers and
    // scanners must not queue fresh work while dispatch is closing.
    archiveTtlSweeper.stop();
    updateCheckService.stop();
    reminderScheduler.stop();
    stopRunReaper();
    subagentService.shutdown();
    systemCursorOverlayLauncher.stop();
    await stopEmbeddingWorker();
    await stopFileIndexing();
    stopCustomToolScanner();
    stopHookScanner();
    stopSkillScanner();
    scheduleService.stop();
    visionThreadService.stopExpirySweep();
    const activeThreads = activeRunTracker.snapshot().activeSessionsByThread;
    for (const { threadId } of activeThreads) {
      abortThread(threadId, { kind: 'server_shutdown', signal });
    }
    const drain = await activeRunTracker.waitForDrain(20_000);
    logger.info(`[shutdown] active run drain: ${drain}`);
    await visionThreadService.stopAll();
    // Reap any agent-spawned shell process trees so they don't outlive the
    // server as orphans (a dev-restart or crash otherwise leaves detached
    // children — e.g. a long-running exec_command — running headless).
    // Background jobs die here too; the next boot tells their agents.
    shellJobService.shutdown();
    const reaped = killAllShellSessions();
    claudeCodeLoginService.shutdown();
    if (reaped > 0) logger.info(`[shutdown] reaped ${reaped} agent shell process tree(s)`);

    if (!activeRunTracker.isIdle) {
      logger.warn(
        `[shutdown] ${activeRunTracker.count} active run(s) — killing without drain (next boot marks their rows failed)`
      );
    }

    await shutdownVoiceEngine();
    wsService.broadcast({ type: 'socket:server:restarting', payload: null });
    wsService.close();

    // Shutdown MCP connections
    try {
      const { mcpService } = await import('@server/services/McpService/index');
      await mcpService.shutdown();
    } catch (err: unknown) {
      logger.warn(`MCP shutdown error (non-fatal): ${getErrorMessage(err)}`);
    }
  } finally {
    // Shutdown must await the pool close before nodemon starts the next
    // process; managed mode deliberately leaves its compatible cluster
    // available for adoption. No snapshot is taken here — backups are
    // user-initiated only (manual or as part of migrate/reset/restore).
    await closeDatabase();
    logger.info('Database connections closed');
  }
}

const shutdownCoordinator = new ProcessShutdownCoordinator({
  cleanup: cleanupForShutdown,
  exit: (code) => process.exit(code),
  restart: () => {
    // With our handler removed, SIGUSR2 reaches nodemon's default handler.
    // This is deliberately the final operation after closeDatabase().
    process.removeAllListeners('SIGUSR2');
    process.kill(process.pid, 'SIGUSR2');
  },
  onDuplicate: (signal) =>
    logger.info(`[shutdown] Already shutting down — ignoring duplicate ${signal}`),
  onError: (signal, error) =>
    logger.error(`[shutdown] ${signal} cleanup failed; refusing automatic restart`, {
      error: getErrorMessage(error),
    }),
});

configureServerShutdown(() => gracefulShutdown('DESKTOP_SHUTDOWN'));

function gracefulShutdown(signal: string): Promise<void> {
  return shutdownCoordinator.request(signal, 'exit');
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

// Last-resort safety nets. Anything reaching these handlers is a bug — the
// fix is to add proper error handling at the source. Logging here keeps the
// process up and gives us a fingerprint instead of a silent crash. The
// reporters are non-reentrant and burst-limited: a failure inside logging
// itself must not be able to re-trigger its own report without end.
const noteSafetyNetSuppression = (windowMs: number): void => {
  logger.error(
    `[process] further uncaught errors are being dropped for up to ${windowMs / 1000}s ` +
      '(too many in a row); see the entries above'
  );
};

process.on(
  'unhandledRejection',
  createSafetyNetReporter(
    (reason: unknown) => {
      logger.error(
        'Unhandled promise rejection',
        reason instanceof Error ? { message: reason.message, stack: reason.stack } : { reason }
      );
    },
    { onSuppressed: noteSafetyNetSuppression }
  )
);

process.on(
  'uncaughtException',
  createSafetyNetReporter(
    (err: unknown) => {
      logger.error('Uncaught exception', {
        message: getErrorMessage(err),
        ...(err instanceof Error
          ? { name: err.name, code: (err as NodeJS.ErrnoException).code, stack: err.stack }
          : {}),
      });
    },
    { onSuppressed: noteSafetyNetSuppression }
  )
);

// Nodemon sends SIGUSR2 on restart. The coordinator does not hand the signal
// back until all shutdown work, especially closeDatabase(), has completed.
process.on('SIGUSR2', () => void shutdownCoordinator.request('SIGUSR2', 'restart'));

startServer();
