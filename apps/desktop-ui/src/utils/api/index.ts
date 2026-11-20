/**
 * Barrel re-export — all API modules and types
 *
 * Existing imports like:
 *   import { agentsApi, type ThreadSummary } from '@desktop/utils/api'
 * continue to work unchanged.
 */

// Core utilities
export { getApiUrl, FetchError } from './core';

// Clone (copy/paste workspace nodes)
export { cloneApi } from './clone';

// Archive
export { archiveApi } from './archive';
export type { ArchivedNode, ArchiveCascadeCounts, ArchiveTreeResponse } from './archive';

// All types
export type {
  StoredImage,
  ThreadSummary,
  ThreadMessage,
  ThreadMessageSubagentResult,
  ThreadActivityLogRecord,
  ThreadParticipant,
  DmThreadSummary,
  MemoryRecord,
  MemoryDetailRecord,
  ThreadSummaryRecord,
  ThreadWorkingDirectory,
  EmbeddingMaintenanceModel,
  EmbeddingMaintenanceNodeType,
  EmbeddingMaintenanceOperation,
  EmbeddingMaintenanceStatus,
  DbSnapshot,
  DbBackupJobStatus,
  DbPreUpdateCheckpoints,
  UserProfile,
  MetadataField,
  ProviderAuthType,
  Provider,
  ProviderType,
  ProviderCredential,
  ProviderDefaultModel,
  ToolRow,
  ModelRow,
  ModelMetadata,
  ProjectRecord,
  ProviderFallbackCredential,
} from './types';

// Domain APIs
export { agentsApi } from './agents';
export { imagesApi } from './images';
export { threadsApi } from './threads';
export type { ThreadContextUsage } from './threads';
export { memoriesApi } from './memories';
export { exportApi } from './export';
export type { ContainerExportReport, DownloadableExportKind, ExportRequest } from './export';
export { runsApi, type RunListItem } from './runs';
export { embeddingsApi } from './embeddings';
export { settingsApi, asAgentUtilityModels, asThreadAgentUtilityModels } from './settings';
export type { SettingsRegistryRecord, UtilityModelRef } from './settings';
export { snagletHomeApi, LOCAL_MODELS_CHANGED_EVENT } from './snagletHome';
export type {
  SnagletHomeState,
  SnagletStorageState,
  SnagletVoiceStorageModel,
  VoiceInstallInfo,
  VoiceModelState,
} from './snagletHome';
export { featureFlagsApi } from './featureFlags';
export { filesApi } from './files';
export type { FileRecord, FileContent } from './files';
export { containersApi } from './containers';
export type {
  ContainerRecord,
  ContainerTreeNode,
  DocTreeNode,
  ThreadTreeNode,
  ImageTreeNode,
  FileTreeNode,
  LibraryTreeChild,
} from './containers';

export { membersApi } from './members';
export type { MemberOption } from './members';

export { docsApi } from './docs';
export type { DocRecord, TransclusionLoopStep } from './docs';

export { projectsApi } from './projects';
export type { IndexConfig, FileIndexingImpact } from './projects';

export { userProfileApi } from './user';
export type { UserOption } from './user';
export { providersApi, providerFallbackCredentialsApi } from './providers';
export { mcpServersApi, type McpServerAgent } from './mcpServers';
export { mcpApiKeysApi } from './mcpApiKeys';
export type { McpApiKey, McpApiKeyMint } from './mcpApiKeys';
export type {
  McpServer,
  McpServerUpsert,
  McpTestResult,
  McpCredentialInput,
  McpInstallInfo,
  McpInstallResult,
  McpTransport,
  McpScope,
} from './types/mcp';
export { databaseApi } from './database';
export { toolsApi, toolWorkspacesApi } from './tools';
export type { WorkspaceFiles, ToolExecuteResult } from './tools';
export type { ToolAvailability } from './types';
export { hooksWorkspacesApi, hookRunsApi } from './hooks';
export type {
  HookWorkspaceInfo,
  HookRegistrationInfo,
  HookDeclaredMeta,
  HookCheckResult,
  HookDeleteResult,
  HookRunInput,
} from './hooks';

export { schedulesApi } from './schedules';

export { modelsApi } from './models';
export { workersApi } from './workers';
export type { WorkerStatusResponse } from './workers';
export type { BulkModelInput, DiscoveredModel, DiscoveryResult } from './models';
export {
  paletteSearchApi,
  paletteHitContext,
  parsePalettePrefix,
  PALETTE_KIND_FILTER_PREFIXES,
  PALETTE_NODE_KINDS,
  PREFIX_FILTER_META,
} from './palette-search';
export type {
  PaletteEntryHit,
  PaletteNodeKind,
  PaletteSearchChannel,
  PaletteSemanticStatus,
  PaletteCoverageMode,
  PaletteSearchHit,
  PaletteSearchKind,
  PaletteAugmentedResponse,
  PaletteFilesystemItem,
  PaletteFileNodeItem,
} from './palette-search';
export { entryFilterFromText, keepTables, planPaletteSearch } from './searchPlan';
export { notificationsApi } from './notifications';
export { appUpdateApi } from './appUpdate';

export { tablesApi } from './tables';
