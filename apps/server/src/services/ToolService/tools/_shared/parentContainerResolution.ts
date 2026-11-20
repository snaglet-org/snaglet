/**
 * parentContainerResolution — shared, loud-failure parent resolution for the
 * workspace create tools (`create_doc`, `create_container`).
 *
 * Small models pass parent keys the schema does not name (e.g.
 * `container: "Release Notes"`); ignoring them would silently create the doc
 * at the workspace root. So:
 *
 *   1. Loosely-named parent keys (`container`, `parent`, `container_name`,
 *      `parent_name`) are recognized. Their value is resolved leniently:
 *      first as a container id, then as a path/name walk from the workspace
 *      root (the same case-insensitive resolution `parent_path` uses).
 *   2. A parent reference that is provided but does not resolve always
 *      throws, naming the unresolved value and pointing at `node` (op tree)
 *      / `resolve_path`; it never falls back to root.
 *   3. Omitting the parent entirely remains valid: placement falls back to
 *      the calling thread's project container, then root (a flat thread);
 *      that default is intentional.
 *
 * Resolution itself stays delegated to the WorkspaceService pathResolver;
 * this layer only decides which reference applies and makes failures loud
 * and actionable.
 */

import { Containers } from '@snaglet/db/tables/containers';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  resolveContainerByPath,
  resolveContainerReference,
} from '@server/services/WorkspaceService/pathResolver';

/** The guidance appended to every unresolvable-parent error. */
const GUIDANCE =
  'Use `node` (op tree) or `resolve_path` to look the container up, then pass `parent_id` ' +
  '(a container id, e.g. "container-1234567890-abcd1234") or `parent_path` (a slash path like ' +
  '"/Projects/Notes"; segment names match case-insensitively, and a bare name matches a ' +
  'root-level container). Omit the parent entirely only if you intend the default location.';

export interface ParentContainerRefs {
  /** Canonical direct container id (`parent_id`, or its `container_id` alias). */
  parentId?: string;
  /** Canonical slash path (`parent_path`, or its `container_path` alias). */
  parentPath?: string;
  /** Value of a loosely-named key (`container`, `parent`, …): id OR path/name. */
  looseValue?: string;
  /** Which loose key carried `looseValue` — used in error messages. */
  looseKey?: string;
}

/**
 * Resolve the parent container for a create tool, or throw a loud, actionable
 * error. Returns the container id, or `null` for workspace root (only when no
 * reference was provided, or the reference explicitly means root).
 */
export async function resolveParentContainerOrThrow(
  toolName: string,
  refs: ParentContainerRefs,
  fallbackThreadId?: string | null
): Promise<string | null> {
  const { parentId, parentPath, looseValue, looseKey = 'container' } = refs;

  // A loose key alongside an explicit parent param must agree with it —
  // conflicting values surface a caller bug instead of silently dropping one.
  if (looseValue !== undefined && (parentId !== undefined || parentPath !== undefined)) {
    if (looseValue !== parentId && looseValue !== parentPath) {
      throw new Error(
        `${toolName}: \`${looseKey}\` ("${looseValue}") conflicts with the explicit parent ` +
          `parameter (${parentId !== undefined ? `parent_id="${parentId}"` : `parent_path="${parentPath}"`}). ` +
          `Drop \`${looseKey}\` or make the values match.`
      );
    }
    // Same value — the explicit parameter governs; fall through.
  }

  // Loose reference only: resolve leniently — id first, then path/name walk.
  if (parentId === undefined && parentPath === undefined && looseValue !== undefined) {
    const byId = await Containers.findById(looseValue);
    if (byId) return byId.id;

    let pathFailure: string | null = null;
    try {
      // `resolveContainerByPath` returns null only for ""/"/" — an explicit
      // root request; any unmatched segment throws.
      return await resolveContainerByPath(looseValue);
    } catch (err) {
      pathFailure = getErrorMessage(err);
    }
    throw new Error(
      `${toolName}: \`${looseKey}\` "${looseValue}" did not resolve to a container — no container ` +
        `has that id, and the path/name lookup failed (${pathFailure}). Nothing was created at ` +
        `root as a fallback. ${GUIDANCE}`
    );
  }

  // Canonical params (or nothing provided → thread-project/root default).
  try {
    return await resolveContainerReference(parentId, parentPath, fallbackThreadId ?? null);
  } catch (err) {
    const message = getErrorMessage(err);

    // A parent_id that failed the id lookup is very often a display NAME.
    // Probe the name walk so the error can hand the model the real id.
    if (parentId !== undefined) {
      let nameHit: string | null = null;
      try {
        nameHit = await resolveContainerByPath(parentId);
      } catch {
        // No name match either — fall through to the generic error.
      }
      if (nameHit) {
        throw new Error(
          `${toolName}: ${message}. "${parentId}" is not a container id, but a container by that ` +
            `NAME exists (id="${nameHit}"). Pass parent_id="${nameHit}", or use parent_path to ` +
            `address containers by name.`
        );
      }
    }

    throw new Error(`${toolName}: ${message}. ${GUIDANCE}`);
  }
}

/** Loose parent keys recognized on the create tools (checked in this order). */
const LOOSE_PARENT_KEYS = ['container', 'parent', 'container_name', 'parent_name'] as const;

/**
 * Pick the loose parent reference out of a raw input object, enforcing that
 * multiple loose keys agree. Returns undefined when none are present.
 * String-typing of each present key must already have been validated by the
 * caller's parse step.
 */
export function pickLooseParentRef(
  input: Record<string, unknown>,
  toolName: string
): { key: string; value: string } | undefined {
  let picked: { key: string; value: string } | undefined;
  for (const key of LOOSE_PARENT_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      throw new Error(`${toolName}: \`${key}\` must be a string when provided`);
    }
    const value = raw.trim();
    // Empty string ≙ absent, matching the create tools' optional-string coercion.
    if (value.length === 0) continue;
    if (picked && picked.value !== value) {
      throw new Error(
        `${toolName}: \`${picked.key}\` ("${picked.value}") and \`${key}\` ("${value}") were both ` +
          `provided with different values. Pass a single parent reference — prefer \`parent_id\` ` +
          `or \`parent_path\`.`
      );
    }
    if (!picked) picked = { key, value };
  }
  return picked;
}
