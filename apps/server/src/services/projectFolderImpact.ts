import path from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';
import { Projects } from '@snaglet/db';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { assertFolderExists } from './projectFolder';
import { compileIgnoreRules } from './fileIndexing/exclusions';
import { readWatchConfig } from './fileIndexing/watchConfig';
import { scanProjectFiles } from './fileIndexing/scan';
import { getProjectIndexingRuntime } from './fileIndexing/projectIndexingStatus';
import { findFolderOverlaps } from './fileIndexing/ownership';

const FOLDER_CONFIRM_FILE_THRESHOLD = 500;
const ROOT_MARKERS = ['.git', 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'pom.xml'];

export interface ProjectFolderImpact {
  folderPath: string;
  eligibleFiles: number;
  scannedEntries: number;
  capped: boolean;
  warnings: string[];
  childRepositories: string[];
  replacingFolder: boolean;
  requiresConfirmation: boolean;
}

/** Read-only candidate inspection. Never writes the indexing gate or starts a watcher. */
export async function inspectProjectFolder(
  candidate: string,
  projectId?: string,
  previousFolder?: string | null
): Promise<ProjectFolderImpact> {
  const folderPath = await realpath(await assertFolderExists(candidate));
  const rules = compileIgnoreRules(await readWatchConfig(folderPath));
  const { impact } = await scanProjectFiles(folderPath, rules);
  const projects = await Promise.all(
    (await Projects.listAll()).map(async (project) => ({
      ...project,
      folderPath: project.folderPath
        ? await realpath(project.folderPath).catch(() => project.folderPath)
        : null,
    }))
  );
  const overlaps = findFolderOverlaps(
    folderPath,
    projects.filter((p) => p.id !== projectId && !p.archived)
  );
  const entries = await readdir(folderPath, { withFileTypes: true });
  const hasRootMarker = entries.some((entry) => ROOT_MARKERS.includes(entry.name));
  // Bounded, immediate-child inspection; never follow symlinks into unrelated trees.
  const childRepositories: string[] = [];
  for (const entry of entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .slice(0, 200)) {
    if (
      await stat(path.join(folderPath, entry.name, '.git')).then(
        () => true,
        () => false
      )
    ) {
      childRepositories.push(entry.name);
    }
  }
  const warnings: string[] = [];
  if (impact.eligibleFiles > FOLDER_CONFIRM_FILE_THRESHOLD)
    warnings.push(
      `This folder contains ${impact.eligibleFiles} eligible files, above the ${FOLDER_CONFIRM_FILE_THRESHOLD}-file review threshold.`
    );
  if (impact.capped)
    warnings.push('The scan reached its limit; the actual file count may be larger.');
  if (overlaps.some((overlap) => overlap.relation === 'contains'))
    warnings.push(
      'This folder contains folders linked to other projects. Check that you selected this project’s own folder.'
    );
  if (childRepositories.length > 1)
    warnings.push(
      `This looks like a folder of repositories. Did you mean one of: ${childRepositories.join(', ')}?`
    );
  if (!hasRootMarker)
    warnings.push(
      'No repository marker was found at the folder root. Check that this is the intended project folder.'
    );
  const canonicalPrevious = previousFolder
    ? await realpath(previousFolder).catch(() => path.resolve(previousFolder))
    : null;
  const replacingFolder = Boolean(canonicalPrevious && canonicalPrevious !== folderPath);
  return {
    folderPath,
    ...impact,
    warnings,
    childRepositories,
    replacingFolder,
    // Only a big folder needs a person's confirmation. The other warnings (no
    // repo marker, a folder of repositories, nested projects) and a changed
    // folder are shown to the person but never block a link.
    requiresConfirmation: impact.eligibleFiles > FOLDER_CONFIRM_FILE_THRESHOLD || impact.capped,
  };
}

/** All server entry points must review risky assignments before mutating data. */
export async function validateProjectFolderChange(
  candidate: string,
  projectId?: string,
  previousFolder?: string | null,
  confirmed = false
): Promise<ProjectFolderImpact> {
  const impact = await inspectProjectFolder(candidate, projectId, previousFolder);
  assertProjectFolderIdle(projectId);
  if (impact.requiresConfirmation && !confirmed) {
    throw new AppError(
      `Folder link needs confirmation: ${impact.warnings.join(' ')} Preview and confirm it in the project’s folder settings.`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.CONFLICT
    );
  }
  return impact;
}

export function assertProjectFolderIdle(projectId?: string): void {
  if (projectId && getProjectIndexingRuntime(projectId).activeExclusiveOp) {
    throw new AppError(
      'Finish or cancel the active indexing operation before changing folders.',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.CONFLICT
    );
  }
}
