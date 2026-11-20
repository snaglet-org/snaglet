import { findProjectAncestorChain } from '@server/services/ToolService/lib/findProjectAncestor';
import { formatProjectSection } from '@server/services/ToolService/lib/formatProjectSection';
import { expandPromptIncludes } from '@server/services/SystemPromptComposer/expandPromptIncludes';

/**
 * buildProjectLineageString: the one builder for the project-section string
 * used by workspace_orient and by the injection stamped onto the first message
 * of an empty thread, so the two can never drift. Nested projects get the full
 * lineage (root → subproject) framed with a path line, `Level N of M` labels,
 * `YOUR DIRECT FOCUS` / `inherited context` roles and a directive to prioritize
 * the deepest level; a single project gets one formatProjectSection block
 * (default heading). Returns null when no enclosing project has a description,
 * folder or GitHub URL, so both surfaces omit the section.
 */
export async function buildProjectLineageString(threadId: string): Promise<string | null> {
  // Walk the full project lineage (subproject → parent → root), not just the
  // nearest project. A subproject's context often only makes sense with its
  // parent's, so we inject the whole chain. Returned nearest-first; reverse
  // to read broad → specific.
  const chain = await findProjectAncestorChain(threadId);

  // Build broad → specific. Only keep levels that actually have overview text,
  // but preserve true tree depth in the labels so the agent understands the
  // nesting even when a middle level has no overview.
  const broadToSpecific = [...chain].reverse();
  const levels: {
    depth: number;
    total: number;
    name: string;
    overview: string;
    folderPath: string | null;
    githubUrl: string | null;
  }[] = [];
  for (let index = 0; index < broadToSpecific.length; index++) {
    const project = broadToSpecific[index];
    const rawOverview = project?.projectDescription?.trim() ?? '';
    // Expand inline `![](doc-…)` includes so a description that inline-links an
    // overview doc injects the doc's text, not the bare link, into both the
    // first-message project injection and workspace_orient. Mirrors the project
    // embedding treatment so what the agent reads at thread start matches what
    // retrieval indexes. Empty/no-include descriptions pass through unchanged.
    const overview = rawOverview ? await expandPromptIncludes(rawOverview) : '';
    const folderPath = project?.folderPath?.trim() || null;
    const githubUrl = project?.githubUrl?.trim() || null;
    // Include a level if it carries any useful context: overview text, a
    // local folder path, or a git repo. A project may have code locations
    // worth knowing even without an overview.
    if (project?.projectName && (overview || folderPath || githubUrl)) {
      levels.push({
        depth: index + 1,
        total: broadToSpecific.length,
        name: project.projectName,
        overview,
        folderPath,
        githubUrl,
      });
    }
  }

  if (levels.length === 0) {
    return null;
  }

  // Renders one project block from the shared formatProjectSection, the same
  // format workspace_orient uses, so the two surfaces can never drift. The
  // nesting framing (Level N of M, YOUR DIRECT FOCUS) is added around this
  // body below; here we use a plain 'Project:' heading to sit inside that frame.
  const renderBody = (level: {
    name: string;
    overview: string;
    folderPath: string | null;
    githubUrl: string | null;
  }): string =>
    formatProjectSection(
      {
        projectName: level.name,
        projectDescription: level.overview,
        folderPath: level.folderPath,
        githubUrl: level.githubUrl,
      },
      { heading: 'Project:' }
    );

  // Single project (no nesting): emit the EXACT same block workspace_orient
  // emits — same shared formatter, same DEFAULT heading ('**Project:**'),
  // same fields, same source (projects table via findProjectAncestor). For a
  // root thread this is byte-identical to orient's project section.
  if (levels.length === 1) {
    const only = levels[0];
    return formatProjectSection({
      projectName: only.name,
      projectDescription: only.overview,
      folderPath: only.folderPath,
      githubUrl: only.githubUrl,
    });
  }

  // Nested: be DIRECTIVE about focus and the broad → narrow funnel.
  const deepest = levels[levels.length - 1];
  const path = levels.map((l) => l.name).join(' → ');

  const header =
    `You are operating inside a NESTED project hierarchy.\n` +
    `Path (broadest → most focused): ${path}\n` +
    `Your DIRECT, PRIMARY focus is the deepest level: "${deepest.name}". ` +
    `The levels above it are inherited context that frames your work — read them broad first, ` +
    `then narrow to your focus. When the deepest level's goals conflict with a broader level, ` +
    `prioritize the deepest (most specific) level unless explicitly told otherwise.`;

  const sections = levels.map((level) => {
    const isFocus = level.depth === deepest.depth;
    const role = isFocus
      ? 'YOUR DIRECT FOCUS (most specific)'
      : level.depth === 1
        ? 'broadest inherited context'
        : 'inherited context';
    return `[Level ${level.depth} of ${level.total} — ${role}]\n${renderBody(level)}`;
  });

  return `${header}\n\n${sections.join('\n\n')}`;
}
