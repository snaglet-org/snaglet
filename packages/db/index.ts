/**
 * Database - Main export point
 */

// Database utilities
export {
  getDb,
  getDbClient,
  closeDbClient,
  initializeDatabase,
  closeDatabase,
  checkDatabaseConnection,
  resolveDatabaseMode,
  transaction,
} from './db';
export type { DbQueryable } from './db';

// Bare `db` / `getDB` re-exports of the engine-agnostic query facade (used by workspace_* tools).
export { db, getDB } from './db-helpers';

// Shared types and helpers
export type * from './types';

// Table exports
export * from './tables/nodes';
export * from './tables/providers';
export * from './tables/provider_auth_types';
export * from './tables/models';
export * from './tables/images';
export * from './tables/users';
export * from './tables/user_provider_credentials';
export * from './tables/agents';
export * from './tables/tools';
export * from './tables/threads';
export * from './tables/members';
export * from './tables/thread_participants';
export * from './tables/messages';
export * from './tables/runs';
export * from './tables/memories';
export * from './tables/embeddings';
export * from './tables/thread_summaries';
export * from './tables/provider_fallback_credentials';
export * from './tables/socket_sessions';
export * from './tables/agent_activity_log';
export * from './tables/settings';
export * from './tables/links';
export * from './tables/projects';
export * from './tables/containers';
export * from './tables/docs';
export * from './tables/placementEvents';
export * from './tables/files';
export * from './tables/mcp_servers';
export * from './tables/mcp_api_keys';
export * from './tables/hook_registrations';
export * from './tables/skill_registry';
export * from './tables/skill_assignments';
export * from './tables/subagents';
export * from './tables/automations';
export * from './tables/hook_runs';
export * from './tables/notifications';
export * from './tables/feature_flags';
export * from './tables/table_catalog';
export * from './tables/table_fields';
export * from './tables/table_entries';
export * from './tables/table_history';
export * from './tables/table_references';

// Base Model class
export { Model } from './Model';
export type {
  ModelDefinition,
  ListOptions,
  CountOptions,
  ColumnMap,
  IntrospectionOptions,
  ColumnInfo,
  DbObjectKind,
  ConstraintType,
  ConstraintInfo,
  IndexInfo,
  ViewDataSource,
} from './Model';
export { View } from './View';
export type {
  ViewDefinition,
  ViewColumnInfo,
  ViewConstraintInfo,
  ViewIndexInfo,
  DescribeResult,
  StatsResult,
  ModelRowType,
} from './View';

// SQL utilities
export * from './sql-utils';

// Actor→member resolution seam for attribution stamps (created_by / last_edited_by).
export * from './actorMember';

// Owner discriminant for agent-XOR-member-owned memory rows.
export * from './ownerRef';
