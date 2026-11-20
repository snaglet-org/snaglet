/**
 * Barrel export file for shared types and utilities
 * Import any shared type or utility from '@snaglet/shared/types'
 */

// API contract types
export type {
  SnagletAgent,
  HealthResponse,
  ApiError,
  ApiSuccess,
  ApiFailure,
  ApiResponse,
  GatewayStatus,
  GatewayActionResponse,
  ServerStatusResponse,
  DbTableSize,
  DbStatsResponse,
} from './api';

export { API_ROUTES } from './api';

// WebSocket types
export type {
  WsMessage,
  WsSubscribeMessage,
  WsSubscribeAck,
  WsConnectedMessage,
  WsErrorMessage,
  WsMessageHandler,
  VisionSessionSource,
  VisionSessionPhase,
  VisionSessionStatePayload,
  VisionSessionStartPayload,
  VisionSessionThreadPayload,
  VisionSessionErrorPayload,
  VisionCaptureRequestPayload,
  VisionCaptureResponsePayload,
  VisionCaptureErrorCode,
  VisionPreviewFramePayload,
  VisionPreviewClearPayload,
} from './ws';
export { WS_PATH } from './ws';

// Auth types and constants
export type { UserDTO } from './auth';

// Clarification (the get_clarification tool's Q/A wire schema)
export type {
  ClarificationQuestionType,
  ClarificationQuestion,
  ClarificationRequest,
  ClarificationStatus,
  ClarificationAnswer,
  ClarificationResult,
  ClarificationRequestPayload,
  ClarificationResponsePayload,
} from './clarification';

// Tool confirmation (interactive approve/deny wire schema)
export type {
  ToolConfirmationDecision,
  ToolConfirmationRequestPayload,
  ToolConfirmationResponsePayload,
  UnattendedPolicy,
  UnattendedWake,
} from './tool-confirmation';
export {
  DEFAULT_UNATTENDED_POLICY,
  UNATTENDED_POLICIES,
  isUnattendedPolicy,
} from './tool-confirmation';

// Global ask feed (agent popups)
export { ASK_EVENT_CHANNEL, ASK_SYNC, ASK_SNAPSHOT, ASK_SETTLED } from './ask-events';
export type { AskSnapshotPayload, AskSettledPayload } from './ask-events';

// Error types and constants
export type { ErrorResponse, ValidationError } from './error';
export { ErrorCode, HTTP_STATUS } from './error';

// Config types (agent, thread)
export type {
  ContentField,
  ModelConfig,
  BudgetConfig,
  DispatchRouting,
  DispatchConfig,
  ToolAccessMode,
  ToolAccessConfig,
  ToolsConfig,
  ToolOverride,
  McpServerEnablementOverride,
  AgentConfig,
  ThreadAgentOverride,
  ThreadConfig,
} from './config';
export { normalizeToolAccessConfig, resolveEnabledMcpServers } from './config';

// Conversation lifecycle (dispatch stop reasons)
export type { ConversationStopReason, ConversationPassKind } from './conversation';
export { CONVERSATION_STOP_REASON_COPY, CONVERSATION_STOP_CONTINUABLE } from './conversation';

// Model / provider metadata
export type {
  ContextCompressionMeta,
  SummaryMeta,
  ModelEntitlementMeta,
  ModelMetadata,
  ProviderDefaultMetadata,
} from './metadata';

// Socket relay message types
export type {
  SocketSessionCreateMsg,
  SocketChatSendMsg,
  SocketChatAbortMsg,
  SocketAgentsListMsg,
  SocketSessionCreatedMsg,
  SocketChatMessageCreatedMsg,
  SocketChatMessageUpdatedMsg,
  SocketAgentTypingMsg,
  SocketAgentStatusMsg,
  SocketAgentContinuingMsg,
  SocketAgentModelMsg,
  SocketDeltaMsg,
  SocketDoneMsg,
  SocketAgentsMsg,
  SocketToolCallMsg,
  SocketToolResultMsg,
  SocketToolConfirmMsg,
  SocketThinkingChunkMsg,
  SocketRunUsageMsg,
  RunTokenUsagePayload,
  RunErrorKind,
  SocketErrorMsg,
  SocketThreadCompactMsg,
  SocketThreadCompactStartedMsg,
  SocketThreadCompactProgressMsg,
  SocketThreadCompactCompleteMsg,
  SocketThreadCompactErrorMsg,
  SocketThreadMemoryExtractionMsg,
} from './socket';

// Static tool execution metadata (declared in definition.ts, drives the panel)
export type { ToolContextRequirement, ToolExecutionMetadata } from './tool-metadata';

// Tools table row + input shapes (db↔wire schema)
export type {
  ToolTier,
  ToolRow,
  CreateToolInput,
  UpdateToolInput,
  ToolAvailability,
} from './tools';

// Re-export utilities for convenience
export { formatTimestamp } from '../utils/dateTime';

// Settings (typed registry on the server)
export type {
  SettingsValueType,
  SettingsOverrideRecord,
  SettingsRegistryRecord,
  SettingsValueRecord,
  SettingsWriteBody,
  SettingsChangedEvent,
} from './settings';
export { SETTINGS_EVENT_CHANNEL, SETTINGS_CHANGED_EVENT } from './settings';

// Workspace container tree (wire schema for GET /api/containers/tree)
export type {
  ContainerTreeNode,
  DocTreeNode,
  ThreadTreeNode,
  ImageTreeNode,
  TreeChild,
} from './container-tree';

// Thread HTTP requests (POST /api/threads, PATCH /api/threads/:id)
export type { ThreadDispatchMode, CreateThreadRequest, UpdateThreadRequest } from './threads';
export { THREAD_TITLE_MAX_LENGTH } from './threads';

// Real-time workspace events (wire schema)
export type {
  ActorKind,
  Actor,
  WorkspaceEventMeta,
  WorkspaceNodeKind,
  WorkspaceNodeSnapshot,
  WorkspaceNodePatch,
  WorkspaceCreatedEvent,
  WorkspaceUpdatedEvent,
  WorkspaceDeletedEvent,
  FileEmbeddingCoverageChangedEvent,
  FileIndexingImpactChangedEvent,
  ThreadStatus,
  ThreadSnapshot,
  ThreadPatch,
  ThreadCreatedEvent,
  ThreadUpdatedEvent,
  ThreadDeletedEvent,
  HookRunStartedEvent,
  HookRunFinishedEvent,
  HookRunsChangedEvent,
  HookEnabledChangedEvent,
  HookRegistryChangedEvent,
  HookRunsChangedReason,
  NotificationCreatedEvent,
  NotificationDismissedEvent,
  WorkspaceEvent,
  WorkspaceEventType,
  WorkspaceEventOfType,
  WorkspaceEventMessage,
  PaneNavigationTarget,
  PaneNavigationMode,
  PaneSplitZone,
  PaneNavigationCommand,
  SerializedPane,
  SerializedPaneSelection,
  PaneLayoutSnapshot,
  UiSidebarRequestEvent,
  UiSidebarResponseEvent,
  UiNavigatePaneEvent,
  UiRequestPaneLayoutEvent,
  UiPaneLayoutResponseEvent,
  UiRegisterClientEvent,
  UiServerEvent,
  UiClientEvent,
  UiEvent,
  UiEventType,
} from './workspace-events';
export { WORKSPACE_EVENT_CHANNEL, isWorkspaceEvent } from './workspace-events';
export { UI_EVENT_CHANNEL, isUiEvent } from './workspace-events';

export type {
  ScheduleKind,
  ScheduleActionKind,
  ScheduleRunStatus,
  OnceScheduleConfig,
  IntervalScheduleConfig,
  CalendarScheduleConfig,
  RruleScheduleConfig,
  FirstOpenScheduleConfig,
  ScheduleConfig,
  HookScheduleAction,
  AutomationScheduleAction,
  ScheduleAction,
  ScheduleRecord,
  ScheduleRunRecord,
  SaveScheduleInput,
} from './schedules';

export type { HookRunSource, HookRunStatus, HookRunRecord } from './hooks';

export type { NotificationType, NotificationRecord } from './notifications';

// Automations: scheduled agent wakes
export {
  AUTOMATION_STATUSES,
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_PROMPT_MAX_LENGTH,
  AUTOMATIONS_TABLE_ID,
  AUTOMATION_FIRST_OPEN_DEFAULT_AFTER,
  type AutomationStatus,
  type AutomationWhenKind,
  type AutomationPausedReason,
  type AutomationWhenInput,
  type AutomationWhen,
  type AutomationLastRun,
  type AutomationRecord,
  type AutomationsResponse,
  type AutomationResponse,
  type AutomationResumeResponse,
  type UndoAutomationResumeRequest,
  type AutomationPauseResponse,
  type UndoAutomationPauseRequest,
  type AutomationActiveLimitDetails,
  type AutomationRunNowResponse,
  type AutomationRunRecord,
  type AutomationRunsResponse,
  type AutomationRecentRun,
  type AutomationRecentRunsResponse,
  type CreateAutomationRequest,
  type UpdateAutomationRequest,
  type AutomationsChangedEvent,
  type WakeOrigin,
} from './automations';

// Background worker controls + status (/api/workers)
export type {
  WorkerMode,
  WorkerPolicyInput,
  ResolvedWorkerPolicy,
  WorkerSweepOutcome,
  WorkerRuntimeStatus,
  WorkerQueueDepth,
  WorkerStatusResponse,
} from './workers';
export { WORKER_MODES, isWorkerMode } from './workers';

// Read-only product-exposure flags served to the desktop UI.
export type { FrontendFeatureFlagName, FrontendFeatureFlags } from './feature-flags';
export {
  CLI_PANE_UI_FLAG,
  FALLBACK_CREDENTIALS_FLAG,
  FRONTEND_FEATURE_FLAG_NAMES,
  HUB_HOME_FLAG,
  LOCAL_MODEL_REMOVAL_UI_FLAG,
} from './feature-flags';

// Thread history trimming (two-phase preview/apply destructive contract).
export type {
  ThreadTrimSides,
  ThreadTrimBytes,
  ThreadTrimTotals,
  ThreadTrimBoundary,
  ThreadTrimSummaryImpact,
  ThreadTrimStats,
  ThreadTrimPreviewRequest,
  ThreadTrimPreview,
  ThreadTrimApplyRequest,
  ThreadTrimApplyResult,
  ThreadTrimmedBroadcast,
} from './thread-trim';
export { emptyThreadTrimTotals } from './thread-trim';

// Subagent helpers: composer strip + parent-thread result rows.
export type {
  SubagentStatus,
  SubagentSummary,
  SubagentChangedPayload,
  SubagentNotice,
  SubagentResultMetadata,
} from './subagents';
export { SUBAGENT_CHANGED_FRAME, SUBAGENT_RESULT_EVENT_KIND } from './subagents';

// Background shell jobs: their start and end rows in the owner's thread.
export {
  SHELL_JOB_ENDED_EVENT_KIND,
  SHELL_JOB_LINE_PREFIX,
  SHELL_JOB_STARTED_EVENT_KIND,
} from './shell-jobs';

// Project file-indexing status + embeddings maintenance (pause ≠ delete).
export type {
  ProjectIndexConfigStatus,
  ProjectIndexingOp,
  ProjectBackfillProgress,
  ProjectIndexingRuntime,
  ProjectIndexingCoverage,
  ProjectIndexingStatus,
  ProjectEmbeddingsClearPreview,
  ProjectEmbeddingsClearResult,
  ProjectBackfillStartResult,
  ProjectBackfillResult,
  ProjectHeldRemovals,
  ProjectApplyHeldRemovalsRequest,
  ProjectApplyHeldRemovalsResult,
} from './project-indexing';

export {
  TABLE_ORIGINS,
  BUILTIN_TABLE_ID_PREFIX,
  CUSTOM_TABLE_ID_PATTERN,
  TABLE_NAME_MAX_LENGTH,
  TABLE_CATALOG_ID_PATTERN,
  isTableCatalogId,
  type TableOrigin,
  type TableCatalogEntry,
  type TableColumnSummary,
  type TableListResponse,
  type TableDetailResponse,
  type CreateTableRequest,
  type CreateTableResponse,
  type RenameTableRequest,
  type RenameTableResponse,
  type UpdateTablePlacementRequest,
  type SetTableProjectResponse,
  TABLE_PROJECT_FILTER_NONE,
  type TableProjectFilter,
  TABLE_LIFECYCLE_STATES,
  type TableLifecycleState,
} from './tables';

export {
  TABLE_HISTORY_DEPTH,
  TABLE_HISTORY_ACTOR_KINDS,
  TABLE_HISTORY_STEP_KINDS,
  type TableHistoryActorKind,
  type TableHistoryActor,
  type TableHistoryStepKind,
  type TableHistoryStep,
  type TableHistoryResponse,
  type TableHistoryStepRequest,
  type TableHistoryStepResponse,
  type TableHistoryConflictDetails,
  type TableHistoryConflict,
  type TableLinkedField,
  type DeleteTableRequest,
  type RestoreTableItemRequest,
  type TableLifecycleResponse,
  type ArchivedTablesResponse,
  type TableFieldLifecycleResponse,
  type ArchivedTableFieldsResponse,
  type SetTableTitleFieldRequest,
  type ArchiveTableCounts,
} from './table-history';

export {
  EDITABLE_TABLE_FIELD_TYPES,
  TABLE_FIELD_DESCRIPTION_MAX_LENGTH,
  CUSTOM_FIELD_ID_PATTERN,
  TABLE_RELATION_MAX_LINKS,
  TABLE_FIELD_WIDTH_MIN,
  TABLE_FIELD_WIDTH_MAX,
  type TableFieldRecurrence,
  type EditableTableFieldType,
  type TableFieldType,
  type TableFieldDefault,
  type TableFieldDefinition,
  type TableField,
  type TableFieldsResponse,
  type CreateTableFieldRequest,
  type UpdateTableFieldRequest,
  type ReorderTableFieldsRequest,
  type UpdateTableFieldViewRequest,
  type SetTableFieldCalendarRequest,
  type TableFieldResponse,
} from './table-fields';

export {
  TABLE_REFERENCE_KINDS,
  TABLE_REFERENCE_KIND_NAMES,
  TABLE_REFERENCE_ID_PATTERN,
  type TableReferenceKind,
  type TableReferenceItem,
  type RelatedTableItems,
  type TableReferenceSearchQuery,
  type TableReferenceSearchResult,
  type TableReferenceSearchResponse,
} from './table-references';

export {
  TABLE_SELECT_OPTION_COLORS,
  TABLE_SELECT_MAX_OPTIONS,
  TABLE_SELECT_OPTION_LABEL_MAX_LENGTH,
  TABLE_SELECT_OPTION_ID_PATTERN,
  type TableSelectOptionColor,
  type TableSelectOption,
  type TableSelectOptionInput,
  type TableSelectOptionUsageResponse,
} from './table-select-options';

export {
  TABLE_ENTRY_PAGE_SIZES,
  TABLE_ENTRY_DEFAULT_PAGE_SIZE,
  TABLE_ENTRY_MAX_PAGE_SIZE,
  TABLE_ENTRY_ID_PATTERN,
  TABLE_ENTRY_DELETE_MAX,
  TABLE_ENTRY_FILTER_MAX_KEEP,
  TABLE_ENTRY_FILTER_MAX_TERMS,
  TABLE_ENTRY_FILTER_QUERY_MAX_LENGTH,
  TABLE_ENTRY_SORT_MAX,
  TABLE_ENTRY_RESOLVE_MAX,
  TABLE_ENTRY_SEARCH_DEFAULT_LIMIT,
  TABLE_ENTRY_SEARCH_MAX_EXCLUDE,
  TABLE_ENTRY_SEARCH_MAX_LIMIT,
  TABLE_ENTRY_SEARCH_MAX_OFFSET,
  TABLE_ENTRY_SEARCH_QUERY_MAX_LENGTH,
  type TableEntryValue,
  type TableEntryValues,
  type TableEntry,
  type TableEntriesQuery,
  type TableEntrySort,
  TABLE_ENTRY_WHERE_MAX,
  TABLE_ENTRY_WHERE_OPERATORS,
  type TableEntryWhereOperator,
  type TableEntryWhere,
  type RelatedTableEntries,
  type TableEntriesResponse,
  type TableEntryResponse,
  type CreateTableEntryRequest,
  TABLE_ENTRY_CREATE_MAX,
  type CreateTableEntriesRequest,
  type CreateTableEntriesResponse,
  type UpdateTableEntryRequest,
  type DeleteTableEntriesRequest,
  type DeleteTableEntriesResponse,
  type TableEntryReferenceCount,
  type TableEntryRef,
  type ResolveTableEntriesRequest,
  type ResolveTableEntriesResponse,
  type TableEntrySearchQuery,
  type TableEntrySearchResult,
  type TableEntrySearchResponse,
} from './table-entries';

export {
  CLAUDE_CODE_LOGIN_TERMINAL_STATES,
  type ClaudeCodeLoginSnapshot,
  type ClaudeCodeLoginState,
} from './claude-code-auth';
// Calendar
export {
  CALENDAR_COLORS,
  CALENDAR_THEME_COLOR_PREFIX,
  CALENDAR_TITLE_MAX_LENGTH,
  CALENDAR_EVENT_DESCRIPTION_MAX_LENGTH,
  CALENDAR_EVENT_TITLE_MAX_LENGTH,
  DEFAULT_CALENDAR_TITLE,
  CALENDAR_OCCURRENCES_MAX_DAYS,
  CALENDAR_DEFAULT_BLOCK_MINUTES,
  CALENDAR_ROW_OCCURRENCES_MAX,
  CALENDAR_INTERVAL_MIN_SECONDS,
  type CalendarColor,
  type CalendarPaletteColor,
  type CalendarThemeColor,
  type CalendarCustomColor,
  type CalendarBoundField,
  type Calendar,
  type CalendarsResponse,
  type CalendarResponse,
  type CreateCalendarRequest,
  type UpdateCalendarRequest,
  type CalendarDeletionPreview,
  type ReorderCalendarsRequest,
  type CalendarEventTime,
  type CalendarEvent,
  type CalendarEventRepeat,
  type CalendarEventResponse,
  type CreateCalendarEventRequest,
  type UpdateCalendarEventRequest,
  type CalendarOccurrenceTime,
  type CalendarOccurrenceStatus,
  type CalendarEventOccurrence,
  type CalendarRowOccurrence,
  type CalendarAutomationOccurrence,
  type CalendarOccurrence,
  type CalendarIntervalSpan,
  type CalendarOccurrencesQuery,
  type CalendarOccurrencesResponse,
  type CalendarTruncatedRow,
  type CalendarChangedEvent,
} from './calendar';
export {
  REMINDER_UNITS,
  REMINDER_SOUNDS,
  DEFAULT_REMINDER_SOUND,
  REMINDER_DUE_EVENT,
  REMINDERS_CHANGED_EVENT,
  type ReminderItemRef,
  type ReminderItemKind,
  type ReminderUnit,
  type ReminderOffset,
  type ReminderSoundId,
  type ReminderSettings,
  type UpdateReminderSettingsRequest,
  type ReminderSettingsResponse,
  type ReminderDue,
  type UpcomingRemindersResponse,
  type NativeNotificationPlatform,
  type NativeNotificationStatus,
} from './reminders';

export {
  THREAD_RUN_ALERT_STATUSES,
  defaultThreadNotificationSettings,
} from './thread-notifications';
export type {
  ThreadRunAlertStatus,
  ThreadNotificationSettings,
  UpdateThreadNotificationSettingsRequest,
  ThreadNotificationSettingsResponse,
  ThreadRunAlert,
} from './thread-notifications';

export type { McpConnectInfo, McpConnectProfile } from './mcp-connect';

export type {
  SemanticOverviewResponse,
  SemanticSizeEstimate,
  SemanticStatus,
  SemanticTableRow,
  UpdateSemanticSearchRequest,
} from './table-semantic';

export * from './sidebar';
