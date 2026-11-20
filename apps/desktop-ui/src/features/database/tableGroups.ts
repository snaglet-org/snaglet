import type { TableCatalogEntry } from '@snaglet/shared/types';
import { compareByName } from '@snaglet/shared/utils';

export interface TableGroups {
  /** Tables linked to no project (`projectId === null`), in input order. */
  workspace: TableCatalogEntry[];
  /** Tables by the project they are linked to, each list in input order. */
  byProject: Map<string, TableCatalogEntry[]>;
}

/**
 * Split catalog entries by project home. The one grouping rule behind the
 * Database sidebar's groups, the workspace tree's per-project Tables groups
 * and the project pane's Tables section. Input order is kept within every
 * group so a caller that sorted first (by name, or by a held edit order)
 * sees that order inside each group; origin is not consulted — built-in
 * tables are workspace-wide by definition and land in `workspace`.
 */
export function groupTablesByProject(tables: readonly TableCatalogEntry[]): TableGroups {
  const workspace: TableCatalogEntry[] = [];
  const byProject = new Map<string, TableCatalogEntry[]>();
  for (const table of tables) {
    if (table.projectId === null) {
      workspace.push(table);
      continue;
    }
    const rows = byProject.get(table.projectId);
    if (rows) rows.push(table);
    else byProject.set(table.projectId, [table]);
  }
  return { workspace, byProject };
}

/** The entries linked to `projectId`, in input order. */
export function tablesOfProject(
  tables: readonly TableCatalogEntry[],
  projectId: string
): TableCatalogEntry[] {
  return groupTablesByProject(tables).byProject.get(projectId) ?? [];
}

/**
 * Tables in their manual order — the order the workspace tree's Tables
 * groups and a project pane's Tables section draw: by `sortOrder`, then by
 * name for any tie (two rows the server has not separated yet).
 */
export function sortTablesByOrder(tables: readonly TableCatalogEntry[]): TableCatalogEntry[] {
  return [...tables].sort((a, b) => a.sortOrder - b.sortOrder || compareByName(a, b));
}
