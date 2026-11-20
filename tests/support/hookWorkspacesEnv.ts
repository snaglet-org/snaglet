/**
 * Import this before anything that loads HookWorkspaceService, which reads
 * HOOK_WORKSPACES_DIR once at module load. Setting it here lets a test import
 * the hooks router statically, at module load and outside every test's
 * timeout, instead of compiling the whole router graph inside its first test.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const hookWorkspacesDir = mkdtempSync(path.join(tmpdir(), 'snaglet-hooks-routes-'));
process.env.HOOK_WORKSPACES_DIR = hookWorkspacesDir;
