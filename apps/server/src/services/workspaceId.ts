/**
 * The id of the workspace this database holds (`workspace.id`). It stays the
 * same across restarts and upgrades, and is new after anything that replaces
 * the content: a new database, a reset to a clean slate, a snapshot restore.
 * Desktop windows compare it with the id stamped on their saved pane layout.
 */
import { randomUUID } from 'node:crypto';
import { settingsService } from '@server/services/settings';
import { workspaceSettings } from '@server/services/settings/categories/workspace';

/** Make an id for a database that has none yet; keep the one it has. */
export async function ensureWorkspaceId(): Promise<string> {
  const current = await settingsService.readOptional(workspaceSettings.id);
  if (current) return current;
  return renewWorkspaceId();
}

/** Give the workspace a new id: its content was replaced. */
export async function renewWorkspaceId(): Promise<string> {
  const id = randomUUID();
  await settingsService.write(workspaceSettings.id, id);
  return id;
}
