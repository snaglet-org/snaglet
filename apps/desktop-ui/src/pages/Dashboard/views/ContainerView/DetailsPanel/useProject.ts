import { useEffect, useState } from 'react';
import { projectsApi, type ProjectRecord } from '@desktop/utils/api';

/** Fetch a single project by id. Returns null while loading or on error. */
export function useProject(projectId: string): ProjectRecord | null {
  const [project, setProject] = useState<ProjectRecord | null>(null);
  useEffect(() => {
    let canceled = false;
    setProject(null);
    projectsApi
      .get(projectId)
      .then((p) => {
        if (!canceled) setProject(p);
      })
      .catch((err: unknown) => {
        // Project may not exist or be inaccessible; leave null.
        console.error('useProject: failed to load project', err);
      });
    return () => {
      canceled = true;
    };
  }, [projectId]);
  return project;
}
