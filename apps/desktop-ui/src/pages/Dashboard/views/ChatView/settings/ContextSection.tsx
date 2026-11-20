import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FC } from 'react';
import { threadsApi } from '@desktop/utils/api';
import { emitLibraryEvent, onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { Button, Select, Stack, Section } from '@desktop/components';
import { projectOptionLabel, useProjectList } from '@desktop/features/database';
import styles from './ChatSettings.module.scss';
import { getErrorMessage } from '@snaglet/shared/utils';
import { CompactAllAgentsPanel } from './CompactAllAgentsPanel';
import { ConversationLimits } from './ConversationLimits';
import { InfoHint } from './InfoHint';
import { NotificationsSection } from './NotificationsSection';
import { PromptEditorSection } from './PromptEditorSection';
import { TextSizeSection } from './TextSizeSection';

interface ContextSectionProps {
  threadId: string;
  onOpenTrim?: () => void;
}

/** The thread's project scope as the picker holds it; `null` until the thread has loaded. */
interface ProjectScope {
  projectId: string | null;
}

/**
 * General section (section id `context`): the thread's project, its text
 * size on this device, its system prompt, run-ended notifications, and the
 * conversation limits. The project is re-read whenever the tree is reshaped,
 * so the picker follows the thread; a change applies optimistically and rolls
 * back on failure. The prompt editor saves explicitly (autosave would adopt
 * the trimmed server value mid-word); an unsaved draft is kept per thread in
 * localStorage.
 */
export const ContextSection: FC<ContextSectionProps> = ({ threadId, onOpenTrim }) => {
  const [savedValue, setSavedValue] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nearTrimThreshold, setNearTrimThreshold] = useState(false);
  const { projects, error: projectsError } = useProjectList();
  const [scope, setScope] = useState<ProjectScope | null>(null);
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  // The thread this section currently shows; a save that outlives a thread
  // switch must not write its outcome into the next thread's picker.
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  useEffect(() => {
    let canceled = false;
    let sequence = 0;
    // A save still pending for the previous thread settles into that
    // thread's guard (see handleProjectChange), so this thread starts clean.
    setScope(null);
    setProjectSaving(false);
    setProjectError(null);

    const load = () => {
      const request = ++sequence;
      threadsApi
        .get(threadId)
        .then((thread) => {
          if (canceled || request !== sequence) return;
          setScope({ projectId: thread.projectId });
        })
        .catch((err: unknown) => {
          if (canceled || request !== sequence) return;
          setProjectError(getErrorMessage(err, 'Failed to load thread'));
        });
    };

    const unsubscribe = onLibraryEvent((event) => {
      if (
        event.type === 'node-moved' ||
        event.type === 'tree-invalidated' ||
        event.type === 'renamed' ||
        event.type === 'archive-changed'
      ) {
        load();
      }
    });
    load();
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, [threadId]);

  const handleProjectChange = useCallback(
    async (e: ChangeEvent<HTMLSelectElement>) => {
      if (!scope) return;
      const target = threadId;
      const next = e.target.value || null;
      const previous = scope.projectId;
      if (next === previous) return;
      setScope({ projectId: next });
      setProjectSaving(true);
      setProjectError(null);
      try {
        await threadsApi.setProject(target, next);
        // The sidebar and any open project pane re-read the tree; the
        // server's realtime patch covers other windows.
        emitLibraryEvent({
          type: 'tree-invalidated',
          ids: [target, previous, next].filter((id): id is string => id !== null),
        });
      } catch (err: unknown) {
        // The section may have moved on to another thread meanwhile; its
        // picker must not inherit this thread's rollback or error.
        if (threadIdRef.current !== target) return;
        setScope({ projectId: previous });
        setProjectError(getErrorMessage(err, 'Failed to move thread'));
      } finally {
        if (threadIdRef.current === target) setProjectSaving(false);
      }
    },
    [scope, threadId]
  );

  // Until this settles the editor shows "Loading…"; a failed load shows its
  // error there instead of leaving "Loading…" up for good.
  useEffect(() => {
    let canceled = false;
    setLoadError(null);
    setSavedValue(null);
    threadsApi
      .get(threadId)
      .then((thread) => {
        if (canceled) return;
        setSavedValue(thread.threadSystemPrompt ?? '');
      })
      .catch((err) => {
        if (!canceled) setLoadError(getErrorMessage(err, 'Failed to load thread'));
      });
    return () => {
      canceled = true;
    };
  }, [threadId]);

  useEffect(() => {
    let canceled = false;
    setNearTrimThreshold(false);
    threadsApi
      .listParticipants(threadId)
      .then((participants) =>
        Promise.all(
          participants
            .filter((participant) => participant.kind === 'agent' && participant.agentId)
            .map((participant) =>
              threadsApi.getContextUsage(threadId, participant.agentId).catch(() => null)
            )
        )
      )
      .then((usages) => {
        if (canceled) return;
        setNearTrimThreshold(
          usages.some(
            (usage) =>
              usage != null &&
              usage.budget.tokenThreshold > 0 &&
              usage.tokens.messageTokens / usage.budget.tokenThreshold >= 0.75
          )
        );
      })
      .catch(() => {
        if (!canceled) setNearTrimThreshold(false);
      });
    return () => {
      canceled = true;
    };
  }, [threadId]);

  const handleSave = useCallback(
    async (next: string): Promise<string | void> => {
      // trimEnd preserves the prior behavior — system prompts shouldn't
      // accumulate trailing whitespace from the editor.
      const trimmed = next.trimEnd();
      await threadsApi.updateSystemPrompt(threadId, trimmed === '' ? null : trimmed);
      // The editor keeps the draft exactly as typed and takes `trimmed` as
      // its baseline; mirroring it here keeps the prop equal to it.
      setSavedValue(trimmed);
      return trimmed;
    },
    [threadId]
  );

  return (
    <Stack gap={4} className={styles.pane}>
      <Section
        label={
          <span className={styles.labelWithHint}>
            Project
            <InfoHint
              topic="the thread's project"
              text="A thread belongs to one project or to none. Its project sets the agents' location and scopes search; moving it here is the same as dragging it onto a project in the sidebar."
            />
          </span>
        }
      >
        <Select
          size="sm"
          aria-label="Thread project"
          value={scope?.projectId ?? ''}
          disabled={projects === null || scope === null || projectSaving}
          onChange={(e) => void handleProjectChange(e)}
        >
          <option value="">No project</option>
          {projects?.map((project) => (
            <option key={project.id} value={project.id}>
              {projectOptionLabel(project)}
            </option>
          ))}
        </Select>
        {(projectError ?? projectsError) && (
          <div className={styles.error} role="alert">
            {projectError ?? projectsError}
          </div>
        )}
      </Section>

      <TextSizeSection threadId={threadId} />

      <PromptEditorSection
        label="Thread system prompt"
        summary={
          savedValue === null
            ? undefined
            : savedValue.trim().length > 0
              ? 'Custom instructions'
              : 'None'
        }
        hint={
          <InfoHint
            topic="the thread system prompt"
            text={
              "Guidance for this conversation, added before every agent's turn. Drag a doc or thread from the sidebar to link it. Click ↳ on a linked doc to transclude it: its full content goes into the prompt at runtime, kept in sync, and shows as a scrollable block. Markdown renders as you type; use / for block commands."
            }
          />
        }
        kind="thread-system-prompt"
        draftScope={`thread-system-prompt:${threadId}`}
        savedValue={savedValue}
        loadError={loadError}
        onSave={handleSave}
      />

      <NotificationsSection threadId={threadId} />

      {nearTrimThreshold && onOpenTrim && (
        <div className={styles.contextTrimNotice} role="status">
          <span>Message history is nearing the auto-compaction threshold.</span>
          <Button variant="ghost" size="sm" onClick={onOpenTrim}>
            Trim now
          </Button>
        </div>
      )}

      <ConversationLimits threadId={threadId} />

      <CompactAllAgentsPanel threadId={threadId} />
    </Stack>
  );
};
