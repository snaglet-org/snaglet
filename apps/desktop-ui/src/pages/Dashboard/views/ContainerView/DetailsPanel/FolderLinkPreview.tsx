import { useEffect, useState } from 'react';
import { ConfirmModal } from '@desktop/components/Modal/ConfirmModal';
import { projectsApi, type ProjectFolderImpact } from '@desktop/utils/api/projects';
import type { ProjectRecord } from '@desktop/utils/api/types';
import { getErrorMessage } from '@snaglet/shared/utils';

export function FolderLinkPreview({
  projectId,
  candidate,
  previousFolder,
  onSaved,
  onCancel,
}: {
  projectId: string;
  candidate: string;
  previousFolder: string;
  onSaved: (project: ProjectRecord & { overlapWarning?: string | null }) => void;
  onCancel: () => void;
}) {
  const [impact, setImpact] = useState<ProjectFolderImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearPreviousIndex, setClearPreviousIndex] = useState(false);
  useEffect(() => {
    let canceled = false;
    setImpact(null);
    setError(null);
    setClearPreviousIndex(false);
    if (candidate) {
      void projectsApi.previewFolderPath(projectId, candidate).then(
        (value) => {
          if (!canceled) setImpact(value);
        },
        (err) => {
          if (!canceled) setError(getErrorMessage(err));
        }
      );
    }
    return () => {
      canceled = true;
    };
  }, [projectId, candidate]);
  return (
    <ConfirmModal
      title={candidate ? 'Review project folder' : 'Unlink project folder?'}
      confirmLabel={candidate ? 'Link this folder' : 'Unlink folder'}
      confirmingLabel="Linking…"
      onCancel={onCancel}
      onConfirm={async () => {
        if (candidate && !impact)
          throw new Error(error ?? 'Wait for the folder preview to finish.');
        const updated = await projectsApi.saveFolderPath(projectId, impact?.folderPath ?? null, {
          confirmFolderLink: true,
          clearPreviousIndex,
        });
        onSaved(updated);
      }}
    >
      <p>{candidate || previousFolder}</p>
      {candidate && !impact && !error && <p role="status">Inspecting folder before linking…</p>}
      {error && <p role="alert">{error}</p>}
      {impact && (
        <>
          <p>
            {impact.eligibleFiles.toLocaleString()} eligible files
            {impact.capped ? ' or more (scan limit reached)' : ''} in {impact.folderPath}.
          </p>
          {impact.warnings.map((warning) => (
            <p key={warning} role="note">
              {warning}
            </p>
          ))}
          <p>Linking allows Snaglet to index this folder using its indexing rules.</p>
          {impact.replacingFolder && (
            <label>
              <input
                type="checkbox"
                checked={clearPreviousIndex}
                onChange={(event) => setClearPreviousIndex(event.target.checked)}
              />
              Clear the previous folder’s cached file index and embeddings before linking. Source
              files are unchanged; shared content still in use is preserved.
            </label>
          )}
        </>
      )}
      {!candidate && (
        <p>
          This removes the linked folder’s cached index and embeddings from this project. Your
          source files remain unchanged.
        </p>
      )}
    </ConfirmModal>
  );
}
