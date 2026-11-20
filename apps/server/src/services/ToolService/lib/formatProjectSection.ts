/**
 * formatProjectSection: the single source of truth for how one project's
 * overview is rendered for an agent, used by workspace_orient and by
 * computePersistedInjection (the first-message injection). The injection adds
 * nesting framing (path line, Level N of M, YOUR DIRECT FOCUS) around these
 * blocks, but the per-project body always comes from here so the two surfaces
 * can never drift.
 *
 * Renders (skipping any field that is blank):
 *   **Project:** <name>
 *   Project files (local path): <folderPath>
 *   Project git repo: <githubUrl>
 *
 *   <description>
 */

export interface ProjectSectionInput {
  projectName: string;
  projectDescription?: string | null;
  folderPath?: string | null;
  githubUrl?: string | null;
}

/**
 * Render a single project's overview block.
 *
 * @param opts.heading - the label for the name line. Defaults to '**Project:**'
 *   (orient style). The injection layer may pass a plain 'Project:' so the
 *   name sits cleanly inside its Level wrapper.
 * @param opts.includeName - when false, omits the name line entirely (the
 *   injection's Level wrapper already states the project name). Defaults true.
 */
export function formatProjectSection(
  project: ProjectSectionInput,
  opts: { heading?: string; includeName?: boolean } = {}
): string {
  const heading = opts.heading ?? '**Project:**';
  const includeName = opts.includeName ?? true;

  const lines: string[] = [];

  if (includeName) {
    lines.push(`${heading} ${project.projectName}`);
  }

  const folder = project.folderPath?.trim();
  if (folder) {
    lines.push(`Project files (local path): ${folder}`);
  }

  const repo = project.githubUrl?.trim();
  if (repo) {
    lines.push(`Project git repo: ${repo}`);
  }

  const description = project.projectDescription?.trim();
  if (description) {
    // blank line between the metadata lines and the prose description
    if (lines.length > 0) lines.push('');
    lines.push(description);
  }

  return lines.join('\n');
}
