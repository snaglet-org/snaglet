import { findProjectAncestor } from '@server/services/ToolService/lib/findProjectAncestor';
import { asTrimmedString } from '@snaglet/shared/utils';

export type StructuredSearchOrder = 'relevance' | 'updated_desc' | 'created_desc';
type ExecutedScopePolicy = 'strict' | 'neutral';

/**
 * Why a scope was applied. `named_project` means the user wrote the project
 * name in the query itself (`... in "Snaglet"`) rather than the surface passing an
 * id, and is reported separately so a client can show WHICH reading it got.
 * `named_table` is a quick-search entry search kept to one table
 * (`table:<name> entry: …`); its `scopeId` is the table's catalog id.
 */
type ExecutedScopeSource = 'explicit' | 'named_project' | 'named_table';

/**
 * A scope the user asked for and did not get.
 *
 * This is never accompanied by results. Reporting the reason instead of
 * quietly widening to the whole workspace is the point: a project-scoped
 * search that silently answers from every project is worse than no answer.
 */
export type ScopeResolutionError = {
  code: 'not_found' | 'ambiguous' | 'conflict';
  /** Human-readable, safe to show directly in the palette. */
  message: string;
  /** The name as the user wrote it, when the failure concerns a name. */
  name?: string;
  /** Competing project names, for `ambiguous`. */
  matches?: string[];
};

export type SearchExecutionMetadata = {
  query: string;
  scopePolicy: ExecutedScopePolicy;
  scopeLabel?: string;
  /** The resolved project/container (or, for `named_table`, table) id the strict filter used. */
  scopeId?: string;
  scopeSource?: ExecutedScopeSource;
  scopeError?: ScopeResolutionError;
  timeLabel?: string;
  ordering: StructuredSearchOrder;
  gaps: string[];
};

export type ScopeSource =
  | 'explicit_project'
  | 'explicit_container'
  | 'inferred_thread'
  | 'no_scope';

export type SearchScope = {
  project_id?: string;
  container_id?: string | 'root';
};

export type CallerContext = {
  thread_id?: string;
  agent_id?: string;
};

export type ResolvedScope = {
  mode: 'project' | 'container_subtree' | 'root' | 'none';
  project_id?: string;
  container_id?: string;
  source: ScopeSource;
};

export async function resolveScope(args: {
  explicit?: SearchScope;
  callerContext?: CallerContext;
}): Promise<ResolvedScope> {
  const explicitContainer = asTrimmedString(args.explicit?.container_id);
  if (explicitContainer === 'root') {
    return { mode: 'root', source: 'explicit_container' };
  }

  const explicitProject = asTrimmedString(args.explicit?.project_id);
  if (explicitProject) {
    return { mode: 'project', project_id: explicitProject, source: 'explicit_project' };
  }

  if (explicitContainer) {
    return {
      mode: 'container_subtree',
      container_id: explicitContainer,
      source: 'explicit_container',
    };
  }

  const threadId = asTrimmedString(args.callerContext?.thread_id);
  if (threadId) {
    const ancestor = await findProjectAncestor(threadId);
    if (ancestor) {
      return { mode: 'project', project_id: ancestor.projectId, source: 'inferred_thread' };
    }
    // Flat thread (not in any project) — search the full workspace.
    return { mode: 'root', source: 'inferred_thread' };
  }

  return { mode: 'none', source: 'no_scope' };
}
