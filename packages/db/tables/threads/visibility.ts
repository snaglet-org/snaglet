/**
 * Two kinds of thread stay out of every list, search and embedding:
 * subagent helper threads (`threads.parent_thread_id` set), reached only
 * through their parent thread, and DM threads (`threads.kind = 'dm'`),
 * reached only through the agent inbox. Every surface that lists, browses or
 * searches threads — or the messages and summaries inside them — leaves them
 * out. Per-id lookups (dispatch, the composer strip, opening the thread by id)
 * still resolve them.
 *
 * One definition per shape, shared by the models, search, archive, embedding
 * and summary queries.
 */

/**
 * A threads row (aliased `alias`) is hidden: a helper thread or a DM thread.
 * The one definition of "hidden" that the exclusion fragments below and the
 * server's per-id check (`isHiddenThread`, which gates live embedding) share.
 * Both columns are set when the row is created and never change.
 */
export function hiddenThreadRowSql(alias: string): string {
  return `(${alias}.parent_thread_id IS NOT NULL OR ${alias}.kind = 'dm')`;
}

/**
 * A threads row (aliased `alias`) is a visible thread, not a helper or DM
 * thread: the NULL-safe negation of {@link hiddenThreadRowSql}. A LEFT JOIN
 * miss (no threads row) passes.
 */
export function visibleThreadRowSql(alias: string): string {
  return `${alias}.parent_thread_id IS NULL AND ${alias}.kind IS DISTINCT FROM 'dm'`;
}

/**
 * True unless `threadIdExpr` names a helper or DM thread. Ids of other rows
 * pass, so
 * it works on a thread node (`n.id`) and on a message's or summary's thread
 * (`m.thread_id`, `ts.thread_id`); a NULL id passes too.
 */
export function helperThreadExclusionSql(threadIdExpr: string): string {
  return `NOT EXISTS (
  SELECT 1 FROM public.threads snaglet_ht
   WHERE snaglet_ht.id = ${threadIdExpr}
     AND ${hiddenThreadRowSql('snaglet_ht')}
)`;
}

/**
 * True unless `nodeIdExpr` is a helper or DM thread, or a message or thread
 * summary inside one. For queries over nodes of any kind (archive listings,
 * palette
 * browse and exact-id lookup). Primary-key probes only.
 */
export function helperThreadContentExclusionSql(nodeIdExpr: string): string {
  return helperThreadExclusionSql(`COALESCE(
    (SELECT snaglet_hm.thread_id FROM public.messages snaglet_hm WHERE snaglet_hm.id = ${nodeIdExpr}),
    (SELECT snaglet_hs.thread_id FROM public.thread_summaries snaglet_hs WHERE snaglet_hs.id = ${nodeIdExpr}),
    ${nodeIdExpr}
  )`);
}
