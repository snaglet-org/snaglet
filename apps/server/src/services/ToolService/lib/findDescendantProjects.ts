/**
 * findDescendantProjects — walk DOWN the nodes.container_id tree from a project
 * container and return the set of project-container ids nested beneath it,
 * INCLUDING the project container itself.
 *
 * Inverse of findProjectAncestor (which walks up to the nearest enclosing
 * project container). Roll-up scope needs the descendant direction: "is this
 * change's project me, or any project nested inside mine?"
 *
 * A project is a container with
 * `category='project'`; the input id is that container's id. Nested project
 * containers are legal, so the descend collects every category='project'
 * container in the subtree. There is no ROOT / all-seeing special case:
 * a loose node with no enclosing project simply has no roll-up scope.
 *
 * Tree mechanics:
 *   - A node lives in a container via nodes.container_id.
 *   - Container C is a CHILD of container F when the node with id = C has
 *     container_id = F.
 *
 * Safety:
 *   - 32-depth cap (depth < 32) — bounds pathological nesting.
 *   - UNION (distinct), not UNION ALL — a container already in the frontier
 *     cannot re-enter, so a container_id cycle terminates instead of looping.
 *
 * Always returns a non-empty array: at minimum [containerId] itself.
 */
import { getDb } from '@snaglet/db';

export async function findDescendantProjects(containerId: string): Promise<string[]> {
  const { rows } = await getDb().query<{ projectId: string }>(
    `
    WITH RECURSIVE descendant_containers AS (
      -- Seed: the project container itself.
      SELECT $1::text AS id, 0 AS depth

      UNION

      -- Descend: container C (= child.id) is a child of frontier F (dc.id)
      -- when the child node's container_id = F. Recurse into those child
      -- containers. UNION (distinct) gives cycle protection.
      SELECT child.id, dc.depth + 1
        FROM descendant_containers dc
        JOIN public.nodes child ON child.container_id = dc.id
       WHERE dc.depth < 32
    )
    SELECT DISTINCT c.id AS "projectId"
      FROM public.containers c
      JOIN public.nodes cn ON cn.id = c.id
     WHERE c.category = 'project'
       AND cn.archived = false
       AND c.id IN (SELECT id FROM descendant_containers)
    `,
    [containerId]
  );

  const ids = rows.map((r) => r.projectId);
  // Never empty: the project always sees itself, even if the query returns
  // nothing (e.g. archived/misconfigured container).
  if (!ids.includes(containerId)) ids.push(containerId);
  return ids;
}
