import { useCallback, useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { projectsApi } from '@desktop/utils/api';
import { socketClient } from '@desktop/socket';
import { TextInput } from '@desktop/components/controls/TextInput/TextInput';
import { WorkspaceEditor } from '@desktop/features/rich-markdown/workspace-editor';
import { draftStorageKey } from '@desktop/features/composer';
import { useDebouncedSave } from '@desktop/pages/Dashboard/hooks/useDebouncedSave';
import { useDisclosure } from '@desktop/pages/Dashboard/hooks/useDisclosure';
import { useOverlayFillHeight } from '@desktop/pages/Dashboard/hooks/useOverlayFillHeight';
import styles from './DetailsPanel.module.scss';
import { useProject } from './useProject';
import { getErrorMessage } from '@snaglet/shared/utils';
import { PropertiesDisclosureHeader } from '../../shared/PropertiesDisclosureHeader';
import { ContainerAttribution } from '../ContainerProperties';
import { IndexingRulesPanel } from './IndexingRulesPanel';
import { EmbeddingsSection } from './EmbeddingsSection';
import { LeafRow } from './LeafRow';
import { FolderLinkPreview } from './FolderLinkPreview';

interface DetailsPanelProps {
  projectId: string;
  /**
   * Overview-tab mode: the panel owns the whole pane, so it renders
   * permanently expanded with no collapse chevron or one-line summary.
   */
  alwaysExpanded?: boolean;
  /** Inside the pull-out Properties panel: no card chrome of its own. */
  flat?: boolean;
}

/**
 * DetailsPanel — collapsible project metadata strip atop the contents grid.
 *
 * Collapsed shows the container name plus a compact category badge. Expanded
 * surfaces overview / optional folder path / optional git repo as opt-in chips
 * and inline editors. Name and github metadata autosave on a 400ms debounce;
 * folder path saves only when the value changes because it validates + links
 * the on-disk folder server-side.
 */
export const DetailsPanel: FC<DetailsPanelProps> = ({
  projectId,
  alwaysExpanded = false,
  flat = false,
}) => {
  const project = useProject(projectId);

  const [expanded, toggleExpanded] = useDisclosure();
  // In Overview-tab mode the panel is never collapsible.
  const isExpanded = alwaysExpanded || expanded;

  const [name, setName] = useState<string | null>(null);
  const [overview, setOverview] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<string>('');
  const [githubUrl, setGithubUrl] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [folderEditing, setFolderEditing] = useState(false);
  const [folderCandidate, setFolderCandidate] = useState<string | null>(null);
  const [githubEditing, setGithubEditing] = useState(false);

  // Folder path is its own explicit "Save" action — it validates the path and
  // creates the on-disk symlink server-side, so it does not autosave with the
  // name/github/overview metadata above.
  const [folderState, setFolderState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>(
    'idle'
  );
  const [folderError, setFolderError] = useState<string | null>(null);
  // Link-time overlap notice from the server ("this folder overlaps project X
  // — files will be shared, not re-indexed"). Warning only, never blocks.
  const [folderWarning, setFolderWarning] = useState<string | null>(null);

  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const detailsBodyRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<string | null>(null);
  nameRef.current = name;
  const folderPathRef = useRef<string>('');
  folderPathRef.current = folderPath;
  const originalFolderPathRef = useRef<string>('');
  const githubUrlRef = useRef<string>('');
  githubUrlRef.current = githubUrl;

  // Collapsible-mode overlay only: cap the floating body to the room below its
  // header (down to a small margin above the viewport bottom) so it fills the
  // available space and scrolls internally when constrained. Overview/fill mode
  // flows in-place with no cap, so it opts out.
  const overlayMaxHeight = useOverlayFillHeight(detailsBodyRef, isExpanded && !alwaysExpanded);

  // Re-sync every editable field to the active project in one effect keyed on
  // the resolved project id. `useProject` nulls `project` as soon as
  // `projectId` changes, so a falsy `project` means loading or none: clear the
  // fields (`name === null` disables the controls and shows "Loading…"). A
  // truthy `project` matches the current id: populate from it and reset the
  // transient save/folder states. One key avoids a blank-then-repopulate flash.
  useEffect(() => {
    if (!project) {
      setName(null);
      setOverview(null);
      setFolderPath('');
      originalFolderPathRef.current = '';
      setGithubUrl('');
      return;
    }
    setName(project.name ?? '');
    setOverview(project.description ?? '');
    const nextFolderPath = project.folderPath ?? '';
    setFolderPath(nextFolderPath);
    originalFolderPathRef.current = nextFolderPath;
    setGithubUrl(project.githubUrl ?? '');
    setSaveState('idle');
    setError(null);
    setFolderState('idle');
    setFolderError(null);
    setFolderWarning(null);
    setFolderCandidate(null);
    setFolderEditing(false);
    setGithubEditing(false);
  }, [project?.id]);

  // Throws on failure (after recording the error message) so
  // useDebouncedSave lands on 'error' instead of 'saved'.
  const persist = useCallback(async () => {
    const pid = projectIdRef.current;
    const nameNow = nameRef.current;
    if (!pid || nameNow === null) return;
    setError(null);
    try {
      const trimmedName = nameNow.trim();
      const trimmedGithub = githubUrlRef.current.trim();
      await projectsApi.update(pid, {
        // Name is required server-side — guard against blanking it.
        ...(trimmedName.length > 0 ? { name: trimmedName } : {}),
        // folderPath is intentionally omitted — it saves through its own
        // explicit Save action (validate + symlink), not this autosave.
        githubUrl: trimmedGithub || null,
      });
    } catch (err) {
      setError(getErrorMessage(err, 'Save failed'));
      throw err;
    }
  }, []);

  const { saveState: state, setSaveState, queueSave, flush } = useDebouncedSave(persist);

  // Mirror the save state so the unmount cleanup below can read it without
  // re-arming the effect on every state change.
  const saveStateRef = useRef(state);
  saveStateRef.current = state;

  // Best-effort flush of unsaved edits on unmount. ContainerView is keyed by
  // container id, so switching projects unmounts this instance — the refs
  // `persist` reads still hold this project's values here. Only fires when
  // dirty: `persist` PATCHes unconditionally, so an unguarded flush would
  // write on every unmount.
  useEffect(() => {
    return () => {
      if (saveStateRef.current === 'dirty') void flush();
    };
  }, [flush]);

  // Explicit folder-path save: validates the path + creates the symlink on the
  // server. A bad path rejects with the server's message and persists nothing.
  // `value` lets the folder picker save the path it just chose without waiting
  // for the folderPath state update to flush.
  const saveFolderPath = useCallback(async (value?: string) => {
    const pid = projectIdRef.current;
    if (!pid) return;
    const raw = (value ?? folderPathRef.current).trim();
    const previous = originalFolderPathRef.current.trim();
    if (raw === previous) {
      setFolderPath(originalFolderPathRef.current);
      setFolderState('idle');
      setFolderError(null);
      return;
    }
    setFolderEditing(false);
    setFolderError(null);
    setFolderCandidate(raw);
  }, []);

  useEffect(() => {
    if (folderState !== 'saved') return;
    const t = setTimeout(() => setFolderState('idle'), 1600);
    return () => clearTimeout(t);
  }, [folderState]);

  const statusLabel =
    state === 'saving'
      ? 'Saving…'
      : state === 'saved'
        ? 'Saved'
        : state === 'dirty'
          ? 'Unsaved'
          : state === 'error'
            ? 'Save failed'
            : '';

  const displayName = name ?? project?.name ?? 'Project';
  const categoryLabel = 'Project';
  const hasFolderPath = folderPath.trim().length > 0;
  const hasGithubUrl = githubUrl.trim().length > 0;
  const folderName = hasFolderPath
    ? folderPath.trim().split('/').filter(Boolean).pop() || folderPath
    : '';

  // Collapsible mode shares one compact inline header row with DocProperties /
  // ContainerProperties (leaf "Properties" label + trailing controls), so the
  // editable name is dialed down from the Overview page-heading size to a
  // compact inline field. Overview/fill mode keeps the prominent title.
  const nameInputClass = alwaysExpanded
    ? styles.detailsNameInput
    : `${styles.detailsNameInput} ${styles.detailsNameInputCompact}`;

  // Header content shared by both modes: the project name (an inline summary
  // when collapsed, an editable input when expanded), the category badge, and
  // the autosave status — laid out inline on one row (matching the doc's
  // compact header). Rendered as the trailing children of the shared
  // PropertiesDisclosureHeader in collapsible mode, or inside the plain header
  // row in Overview / alwaysExpanded mode (which has no collapse toggle).
  const headerContent = (
    <>
      {!isExpanded ? (
        <button
          type="button"
          className={styles.detailsSummary}
          onClick={toggleExpanded}
          title={`${displayName} · ${categoryLabel}`}
        >
          <span className={styles.detailsSummaryName}>{displayName}</span>
        </button>
      ) : (
        <input
          className={nameInputClass}
          value={name ?? ''}
          disabled={name === null}
          onChange={(e) => {
            setName(e.target.value);
            queueSave('debounced');
          }}
          onBlur={() => queueSave('immediate')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              queueSave('immediate');
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="Project name"
          spellCheck={false}
        />
      )}

      {/* Category pill sits right after the name — the analog of DocProperties'
          type badge — with the autosave status pinned last on the same row. */}
      <span className={styles.projectKindBadge}>{categoryLabel}</span>

      {isExpanded && (
        <span
          className={styles.detailsStatus}
          data-state={state}
          title={error ?? undefined}
          aria-live="polite"
        >
          {statusLabel}
        </span>
      )}
    </>
  );

  return (
    <section
      className={styles.detailsPanel}
      data-expanded={isExpanded || undefined}
      data-editing={isExpanded || undefined}
      data-fill={alwaysExpanded || undefined}
      data-flat={flat || undefined}
    >
      {alwaysExpanded ? (
        // Overview tab: the panel owns the whole pane and never collapses, so
        // it keeps a plain header row with no disclosure toggle.
        <header className={styles.detailsHead}>{headerContent}</header>
      ) : (
        // Collapsible mode: the same shared Properties disclosure header used by
        // DocProperties / ContainerProperties, so the leaf toggle is identical
        // across every node's Properties panel.
        <PropertiesDisclosureHeader expanded={isExpanded} onToggle={toggleExpanded}>
          {headerContent}
        </PropertiesDisclosureHeader>
      )}

      {isExpanded && (
        <div
          ref={detailsBodyRef}
          className={`${styles.detailsBody}${
            alwaysExpanded ? '' : ` ${styles.detailsBodyOverlay}`
          }`}
          // Overlay mode is content-driven: the body grows to fit its content
          // (metadata + the autosizing description) and caps at the measured
          // room below the header, scrolling internally when even that isn't
          // enough. Fill mode flows in the pane with no inline cap.
          style={alwaysExpanded ? undefined : { maxHeight: overlayMaxHeight }}
        >
          {folderCandidate !== null && (
            <FolderLinkPreview
              projectId={projectId}
              candidate={folderCandidate}
              previousFolder={originalFolderPathRef.current}
              onCancel={() => {
                setFolderCandidate(null);
                setFolderPath(originalFolderPathRef.current);
                setFolderState('idle');
              }}
              onSaved={(updated) => {
                const normalized = updated.folderPath ?? '';
                setFolderPath(normalized);
                originalFolderPathRef.current = normalized;
                setFolderWarning(updated.overlapWarning ?? null);
                setFolderState('saved');
                setFolderEditing(false);
                setFolderCandidate(null);
              }}
            />
          )}
          <div className={styles.projectMetaStrip}>
            {folderEditing ? (
              <div className={styles.inlineConnectionEditor}>
                <TextInput
                  fullWidth
                  value={folderPath ?? ''}
                  disabled={name === null || folderState === 'saving'}
                  autoFocus
                  onChange={(e) => {
                    const next = e.target.value;
                    setFolderPath(next);
                    setFolderState(
                      next.trim() === originalFolderPathRef.current.trim() ? 'idle' : 'dirty'
                    );
                    if (folderError) setFolderError(null);
                  }}
                  onBlur={() => {
                    if (folderState === 'dirty') {
                      setFolderEditing(false);
                      void saveFolderPath();
                    } else {
                      setFolderPath(originalFolderPathRef.current);
                      setFolderState('idle');
                      setFolderEditing(false);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void saveFolderPath();
                      (e.target as HTMLInputElement).blur();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setFolderPath(originalFolderPathRef.current);
                      setFolderState('idle');
                      setFolderEditing(false);
                    }
                  }}
                  placeholder="/Users/you/code/project-name"
                  aria-label="Project folder path"
                />
                <button
                  type="button"
                  className={styles.folderPickerBtn}
                  title="Browse local machine for folder"
                  disabled={folderState === 'saving'}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={async () => {
                    const picked = await socketClient.pickFolder('Select Project Folder');
                    if (picked) {
                      setFolderPath(picked);
                      void saveFolderPath(picked);
                    }
                  }}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 15 15"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden="true"
                  >
                    <path
                      d="M1 3.5A1.5 1.5 0 0 1 2.5 2H6l1.5 1.5H13A1.5 1.5 0 0 1 14.5 5v6A1.5 1.5 0 0 1 13 12.5H2A1.5 1.5 0 0 1 .5 11V3.5H1Z"
                      stroke="currentColor"
                      strokeWidth="1"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M7.5 9.5V6m0 0L6 7.5M7.5 6l1.5 1.5"
                      stroke="currentColor"
                      strokeWidth="1"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={styles.connectionChip}
                data-state={folderState === 'saving' ? 'saving' : undefined}
                onClick={() => setFolderEditing(true)}
              >
                {folderState === 'saving'
                  ? 'Saving folder…'
                  : hasFolderPath
                    ? `Folder: ${folderName}`
                    : '+ Add folder'}
              </button>
            )}

            {githubEditing ? (
              <div className={styles.inlineConnectionEditor}>
                <TextInput
                  fullWidth
                  value={githubUrl ?? ''}
                  disabled={name === null}
                  autoFocus
                  onChange={(e) => {
                    setGithubUrl(e.target.value);
                    queueSave('debounced');
                  }}
                  onBlur={() => {
                    queueSave('immediate');
                    setGithubEditing(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      queueSave('immediate');
                      (e.target as HTMLInputElement).blur();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setGithubEditing(false);
                    }
                  }}
                  placeholder="https://github.com/owner/repo"
                  aria-label="Project git repository URL"
                />
              </div>
            ) : (
              <button
                type="button"
                className={styles.connectionChip}
                onClick={() => setGithubEditing(true)}
              >
                {hasGithubUrl ? 'Git repo linked' : '+ Add Git repo'}
              </button>
            )}
          </div>

          {folderState === 'dirty' && (
            <div className={styles.folderSaveMsg}>Folder path changed.</div>
          )}
          {folderState === 'saved' && <div className={styles.folderSaveMsg}>Folder linked.</div>}
          {folderState === 'error' && folderError && (
            <div className={styles.errorBanner}>{folderError}</div>
          )}
          {folderWarning && (
            <div className={styles.warningBanner} role="status">
              {folderWarning}
            </div>
          )}

          {/* Quiet read-only attribution line (created by / updated / edited
              by) — the same component the folder Properties dropdown renders. */}
          <ContainerAttribution containerId={projectId} />

          {/* Embeddings status + actions (enable/disable · backfill · clear)
              and vector coverage. Pausing here is reversible and preserves
              data; deletion only happens through the section's confirmed
              Clear action. */}
          {hasFolderPath && <EmbeddingsSection projectId={projectId} />}

          {/* Collapsed leaves keep the default view compact: the rich-text
              description editor (explicit Save — nothing is sent while
              typing; an unsaved draft is kept per project in localStorage),
              the embeddings explainer, and the indexing rules. */}
          <LeafRow label="Description">
            <Field grow className={styles.descriptionField}>
              {overview === null ? (
                <div className={styles.detailsPlaceholder}>Loading…</div>
              ) : (
                <div className={styles.detailsOverviewHost}>
                  <WorkspaceEditor
                    key={projectId}
                    kind="project-description"
                    saveMode="manual"
                    draftKey={draftStorageKey(`project-description:${projectId}`)}
                    savedValue={overview}
                    onSave={async (next) => {
                      // The server trims (and stores blank as null); the
                      // editor keeps the draft as typed and takes this as
                      // its baseline.
                      const updated = await projectsApi.update(projectId, { description: next });
                      const canonical = updated.description ?? '';
                      setOverview(canonical);
                      return canonical;
                    }}
                    placeholder="Project description — what is this project?"
                    bodyClassName={styles.detailsOverviewEditor}
                  />
                </div>
              )}
            </Field>
          </LeafRow>

          {hasFolderPath && (
            <LeafRow label="How project embeddings work">
              <div className={styles.embeddingsExplainer}>
                <p>
                  When files are edited or added in <code>{folderPath.trim()}</code>, Snaglet can
                  add or update vectors in its local database so you and your agents can
                  semantically search and retrieve files faster. This can save substantial context
                  and tokens in large codebases or folders with many files.
                </p>
                <p>
                  The embeddings model runs locally on your computer and is free to use. Snaglet
                  automatically excludes unsupported or non-text files such as images, audio, video,
                  lockfiles, and dot-prefixed folders such as <code>.git</code> and{' '}
                  <code>.turbo</code>.
                </p>
                <p>
                  You can customize which paths or files Snaglet includes or ignores. Rules may use
                  roots or globs such as <code>src</code>, <code>docs</code>,{' '}
                  <code>apps/*/src</code>, or <code>**/*.md</code>. Ignore and always-exclude rules
                  take precedence.
                </p>
                <p>
                  Snaglet stores this folder&rsquo;s indexing preference in{' '}
                  <code>snaglet.config.json</code> inside the folder. Disabling background indexing
                  pauses future checks and keeps existing embeddings;{' '}
                  <strong>removing the file un-configures the folder and deletes its index</strong>{' '}
                  — use the Disable action instead if you only want to pause.
                </p>
              </div>
            </LeafRow>
          )}

          {hasFolderPath && (
            <LeafRow label="Indexing paths and rules">
              <IndexingRulesPanel projectId={projectId} />
            </LeafRow>
          )}

          {error && state === 'error' && <div className={styles.errorBanner}>{error}</div>}
        </div>
      )}
    </section>
  );
};

const Field: FC<{ label?: ReactNode; grow?: boolean; className?: string; children: ReactNode }> = ({
  label,
  grow,
  className,
  children,
}) => (
  <div
    className={[styles.detailsField, grow ? styles.detailsFieldGrow : '', className ?? '']
      .filter(Boolean)
      .join(' ')}
  >
    {label != null && <span className={styles.detailsFieldLabel}>{label}</span>}
    {children}
  </div>
);
