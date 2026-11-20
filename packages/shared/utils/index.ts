/**
 * Barrel export for shared utilities
 */

// Date/time utilities
export {
  elapsedMs,
  isoNow,
  isoStamp,
  relativeFromNow,
  formatTimestamp,
  startOfToday,
  formatRelativeTime,
  formatClockTime,
  formatClockTime24,
  formatClockTimeWithSeconds,
  formatShortDate,
  formatDateTime,
  formatLongDate,
  sleep,
  parseIntervalToMs,
  MIN_INTERVAL_MS,
} from './dateTime';

// Number utilities
export {
  parseOptionalPositiveInt,
  requirePositiveInt,
  formatUptime,
  formatBytes,
  asFiniteNumber,
  clampInt,
} from './numbers';

// Text utilities
export {
  wordCount,
  withLineNumbers,
  truncate,
  getInitial,
  getInitials,
  findAndReplace,
  escapeXml,
} from './text';
export type { FindReplaceResult, FindReplaceOptions } from './text';
export { maskCodeRegions } from './markdownCode';

// File utilities
export {
  DOC_IMPORT_EXTENSIONS,
  IMAGE_NAME_MAX_LENGTH,
  MAX_DOC_IMPORT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIZE_LABEL,
  imageNameProblem,
  imageSizeProblem,
  isImageFileName,
  isRenamableProjectFile,
  readFileAsDataUrl,
} from './file';

// Type guard utilities
export {
  isRecord,
  asNonEmptyString,
  asTrimmedString,
  readTrimmedString,
  asStringArray,
  normalizeStringArray,
  requireString,
} from './type-guards';

// String case conversion & text helpers
export {
  snakeToCamel,
  camelToSnake,
  toSnakeCase,
  slugifyAgentName,
  isHttpUrl,
  generateId,
  normalizeWhitespace,
  capitalize,
  parseCsv,
  snippet,
  vectorLiteral,
  recencyScore,
  flattenTextBlocks,
  escapeRegex,
} from './strings';

// Error utilities and classes
export { getErrorMessage, AppError, AuthError, ConflictError, RateLimitError } from './errors';

// JSON utilities
export { safeJsonParse } from './json';

// Array utilities
export { compareByName, compareNames, deduplicateBy, unique } from './arrays';

// Math utilities
export { clamp } from './math';

// Model picker order and labels (shared by the model routes, the default-model
// suggestion and every model dropdown)
export { modelOptionLabels, sortModels } from './modelOrder';

// Thread-summary provenance (shared by the summary card + export transcript)
export { parseModelUsed, formatModelUsed } from './modelProvenance';
export type { ModelProvenance } from './modelProvenance';

// Tool-access permission rule helpers (shared by server engine + UI editor)
export {
  GUARDED_TOOL_KINDS,
  isGuardedTool,
  guardKindFor,
  parseRule,
  formatRule,
} from './toolRules';
export type { GuardKind, ParsedRule } from './toolRules';

// Tool id grammar (tool workspace ids and `tool:<id>` references).
export { TOOL_ID_SOURCE, isToolId } from './toolId';

// Permanent builtin tool-id compatibility aliases.
export {
  CALENDAR_READ_OPS,
  CALENDAR_WRITE_OPS,
  TOOL_ALIASES,
  resolveToolId,
  transformToolAliasParams,
  toolIdsEquivalent,
  toolAliasIdsFor,
  isRetiredToolId,
  canonicalToolName,
} from './toolAliases';
export type {
  ToolAliasSpec,
  ToolParamTransform,
  ToolParams,
  ToolPins,
  ToolPinValue,
  ResolvedToolId,
} from './toolAliases';
export {
  TOOL_OP_PARAM,
  scopeRule,
  isOpScopedEntry,
  isPinScoped,
  allowRuleCoversCall,
  describeAllowScope,
  formatAllowScopes,
  isPlainNameAlias,
  ruleNamesTool,
  evaluateOpAccess,
  readToolOp,
} from './toolOpRules';
export type { ScopedRule, OpRuleOptions, OpVerdict, ToolRuleSide } from './toolOpRules';
export { formatTableName, RESERVED_FIELD_NAMES, tableNameProblem } from './tableName';
export {
  normalizeTableFieldDefinition,
  tableFieldDefinitionProblem,
  tableFieldRecurrenceProblem,
  tableFieldWidthProblem,
} from './tableFields';
export { tableEntryValueProblem } from './tableEntries';
export {
  isTableReferenceKind,
  tableReferenceChip,
  tableReferenceIdsInText,
  tableReferenceKindArticle,
  tableReferenceKindName,
  unwrapTableReferenceChip,
} from './tableReferences';
export {
  isTableDateTime,
  parseTableDateTime,
  tableDateTimeLocalDate,
  tableDateTimeToUtc,
  userTimeZone,
} from './tableDateTime';
export type { ParsedTableDateTime } from './tableDateTime';
export {
  formatTableDateRange,
  parseTableDateRange,
  tableDateRangeToCanonical,
} from './tableDateRange';
export type { TableDateRange, TableDateRangeKind, TableDateRangeParse } from './tableDateRange';
export {
  REPEAT_INTERVAL_MAX_SECONDS,
  REPEAT_INTERVAL_MIN_SECONDS,
  TABLE_REPEAT_SCAN_LIMIT,
  advanceTableRepeat,
  createTableRepeat,
  describeTableRepeat,
  formatRepeatInterval,
  intervalRepeatRule,
  isTableRepeatOverdue,
  isTableRepeatUpcoming,
  jumpTableRepeatToUpcoming,
  nextRepeatOccurrence,
  normalizeRepeatRule,
  repeatIntervalProblem,
  repeatOccurrenceToColumn,
  skipTableRepeatToUpcoming,
  tableRepeatIntervalOccurrences,
  tableRepeatIntervalSeconds,
  tableRepeatProblem,
  tableRepeatToday,
  tableRepeatWallTime,
  tableRepeatWriteProblem,
  upcomingRepeatOccurrences,
  upcomingTableRepeatItems,
} from './tableRecurrence';
export type {
  TableRepeat,
  TableRepeatItem,
  TableRepeatKind,
  TableRepeatLogEntry,
  TableRepeatResult,
  TableRepeatUnit,
  TableRepeatWeekday,
} from './tableRecurrence';
export {
  MONTHS_SHORT,
  anchorNth,
  fmtClock,
  fmtDay,
  fmtDayIn,
  fmtRange,
  fmtShort,
  normalizeRepeatDraft,
  ordinal,
  repeatDraftFor,
  repeatDraftFromRepeat,
  repeatDraftHasTime,
  repeatDraftIntervalProblem,
  repeatDraftSummary,
  repeatDraftUpcoming,
  repeatEveryOf,
  repeatEverySeconds,
  repeatInputFromDraft,
  tableRepeatCellText,
  tableRepeatSummary,
  weekdayLong,
  weekdayOf,
  weekdayShort,
} from './tableRepeatSpec';
export { REPEAT_WEEKDAYS } from './tableRepeatPeriods';
export type {
  RepeatDraft,
  RepeatEnds,
  RepeatEvery,
  RepeatMode,
  RepeatMonthOn,
  TableRepeatInput,
} from './tableRepeatSpec';
export {
  AUTOMATION_HUMAN_MIN_EVERY_MS,
  AUTOMATION_MAX_EVERY_MS,
  AUTOMATION_SHORT_WINDOW_MAX_MS,
  AUTOMATION_WINDOWED_MIN_EVERY_MS,
  REPEAT_WEEKDAY_CODES,
  automationFloorError,
  describeAutomationWhen,
  describeEvery,
  describeRepeatRule,
  firstOpenSlot,
  firstOpenTick,
  formatAutomationDuration,
  formatAutomationInstant,
  formatTimeOfDay,
  instantToWallTime,
  intervalWindowMs,
  intervalWindowOf,
  isKnownTimeZone,
  isWithinIntervalWindow,
  localDayBounds,
  matchQuickRepeat,
  nextAutomationRun,
  nextFirstOpenRun,
  nextRepeatRun,
  nextWindowedIntervalRun,
  normalizeAutomationWhen,
  parseAutomationDuration,
  quickRepeatRule,
  repeatRunsBetween,
  repeatSeries,
  wallTimeToInstant,
} from './automationTiming';
export type {
  AutomationWhenResult,
  DescribeAutomationWhenOptions,
  FirstOpenTick,
  IntervalWindow,
  NormalizeWhenOptions,
  RepeatQuick,
  RepeatQuickChoice,
  RepeatTiming,
  RepeatWeekdayCode,
} from './automationTiming';

export {
  CALENDAR_COLOR_FORMATS,
  calendarColorParts,
  normalizeCalendarColor,
  normalizeHexColor,
  type CalendarColorParts,
} from './calendarColors';

export {
  resolveSelectOptions,
  selectOptionChanges,
  selectOptionLabelProblem,
  selectOptionsProblem,
  selectValueProblem,
  type SelectOptionChanges,
} from './tableSelectOptions';

// Calendar: the days of a year worth marking
export { FEW_A_YEAR, notableByDay } from './calendarNotableDays';

// Doc line links: `doc-…#L12-L20` chips that point at part of a doc
export {
  LINE_FRAGMENT_SOURCE,
  LINE_FRAGMENT_SQL_SOURCE,
  formatLineFragment,
  lineRefLabel,
  lineRefOffsets,
  parseLineFragment,
  sliceLineRef,
  splitLineRef,
  withLineRef,
  type LineRef,
  type LineSlice,
  type SplitLineRef,
} from './docLineRef';

// Doc heading links: `doc-…#h=rate-limits` chips that point at a section
export {
  HEADING_FRAGMENT_SOURCE,
  docAnchorLabel,
  docHeadings,
  docOutline,
  findHeadingSection,
  formatHeadingFragment,
  headingRangeFor,
  headingRangeForLines,
  headingRefFor,
  headingRefLabel,
  headingSlug,
  parseHeadingFragment,
  parseInDocHeadingHref,
  resolveDocAnchor,
  sliceDocAnchor,
  splitDocRef,
  type DocAnchor,
  type DocHeading,
  type HeadingEnd,
  type HeadingRef,
  type HeadingSection,
  type ResolvedAnchor,
  type SplitDocRef,
} from './docHeadingRef';

// Transclusions: `![label](doc-…)` shows another doc's content in place
export {
  findTransclusions,
  LINK_LABEL_SOURCE,
  transcludedDocIds,
  type TransclusionHit,
} from './transclusions';
