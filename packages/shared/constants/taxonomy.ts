/**
 * Node-model taxonomy — the annotation axis on containers.
 *
 *   Container `category` — optional light grouping semantic (`project`, or
 *   NULL = plain organization). A project container is the scope that
 *   threads and tables attach to.
 *
 * Docs carry no type of their own, and Snaglet ships no fixed task schema. A task
 * is a row in a Database table (user-defined): status, due date, assignee and
 * the rest are ordinary table fields, and the row's prose, when it has any,
 * is a doc linked through a `relation` field of kind `doc`. The doc fields
 * (`due_at`, `assigned_to`, `priority`) live on `docs` and are meaningful on
 * any doc.
 *
 * This module is the single source of truth for the allowed values, shared by
 * both apps. The Postgres CHECK constraints mirror these arrays and enforce
 * them; tool and route validation use the same arrays for fast, friendly
 * errors. Adding a value means editing both this file and a migration.
 *
 * Values outside these arrays (including the removed `reference`, `log` and
 * `status` categories) fail validation rather than being silently translated.
 * Nothing in this taxonomy influences search ranking.
 */

/** Container category values. NULL (absent) = plain organization, the default. */
export const CONTAINER_CATEGORY = {
  PROJECT: 'project',
} as const;

export const CONTAINER_CATEGORIES = [CONTAINER_CATEGORY.PROJECT] as const;

export type ContainerCategory = (typeof CONTAINER_CATEGORIES)[number];

/**
 * Doc work-item priority values. Optional + nullable (NULL/absent = no
 * priority set) and meaningful on any doc. Shared by the UI's priority picker
 * and the doc route validation so the two never drift.
 */
export const DOC_PRIORITY = {
  URGENT: 'urgent',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
} as const;

export const DOC_PRIORITIES = [
  DOC_PRIORITY.URGENT,
  DOC_PRIORITY.HIGH,
  DOC_PRIORITY.MEDIUM,
  DOC_PRIORITY.LOW,
] as const;

export type DocPriority = (typeof DOC_PRIORITIES)[number];

export function isContainerCategory(value: unknown): value is ContainerCategory {
  return typeof value === 'string' && (CONTAINER_CATEGORIES as readonly string[]).includes(value);
}

export function isDocPriority(value: unknown): value is DocPriority {
  return typeof value === 'string' && (DOC_PRIORITIES as readonly string[]).includes(value);
}
