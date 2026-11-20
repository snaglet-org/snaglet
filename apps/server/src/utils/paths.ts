import { expandHomePath } from '@snaglet/shared/utils/paths';

/**
 * Expand a leading `~` to the current user's home directory.
 *
 * Plain home expansion only — delegates to the shared `expandHomePath` so the
 * server and packages/db agree on the semantics. The Snaglet-home-aware variant
 * that also rewrites `~/.snaglet` via `$SNAGLET_HOME` lives in
 * `services/localModels/localModelManifest`, and the `$HOME`-reading variant
 * used by the filesystem tool handler is deliberately separate — do not
 * collapse them into this one.
 */
export function expandHome(input: string): string {
  return expandHomePath(input);
}
