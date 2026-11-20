/**
 * Shared type definitions for the API layer.
 *
 * Definitions live in per-domain files under `./types/`; this barrel
 * re-exports everything so existing `from './types'` imports keep working.
 */

export * from './types/agents';
export * from './types/database';
export * from './types/embeddings';
export * from './types/mcp';
export * from './types/misc';
export * from './types/providers';
export * from './types/threads';
export * from './types/tools';
export * from './types/workspace';
