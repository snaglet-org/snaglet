/**
 * Subagent helpers are ordinary agent rows with
 * `agents.parent_agent_id` set. They live and die inside one parent thread,
 * so agent lists, pickers, palette and name lookups leave them out; per-id
 * lookups still resolve them.
 */

/** An agents row (aliased `alias`) is not a helper. Holds for a LEFT JOIN miss too. */
export function helperAgentExclusionSql(alias: string): string {
  return `${alias}.parent_agent_id IS NULL`;
}

/**
 * A members row (aliased `memberAlias`) is not a helper's. User and external
 * members pass.
 */
export function helperMemberExclusionSql(memberAlias: string): string {
  return `NOT EXISTS (
  SELECT 1 FROM public.agents snaglet_ha
   WHERE snaglet_ha.id = ${memberAlias}.agent_id AND snaglet_ha.parent_agent_id IS NOT NULL
)`;
}
