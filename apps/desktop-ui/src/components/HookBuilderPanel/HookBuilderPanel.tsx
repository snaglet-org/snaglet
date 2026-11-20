import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { Button, Select, Tabs, TextInput } from '@desktop/components';
import { isUnattendedPolicy } from '@snaglet/shared/types';
import { UNATTENDED_POLICY_HINT, UNATTENDED_POLICY_OPTIONS } from '@desktop/utils/unattendedPolicy';
import {
  FetchError,
  hooksWorkspacesApi,
  type HookRegistrationInfo,
  type HookWorkspaceInfo,
} from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import { emitLibraryEvent, onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { ConfirmModal } from '@desktop/components/Modal';
import { BuilderExternalChangeNotice, useExternalFileChange } from '../BuilderExternalChange';
import { hasDefaultExport } from '../HandlerEditor/handlerEditorSupport';
import { HookSchedulesPanel } from './HookSchedulesPanel';
import { HookRunsPanel } from './HookRunsPanel';
import { HookRunAsControl } from './HookRunAsControl';
import { HookTestConsole } from './HookTestConsole';
import {
  HOOK_EVENT_NAMES,
  HOOK_TRIGGER_LABELS,
  scaffoldHookTs,
  validateHookName,
} from './scaffold';
import styles from './HookBuilderPanel.module.scss';

const HandlerEditor = lazy(() =>
  import('../HandlerEditor/HandlerEditor').then((mod) => ({ default: mod.HandlerEditor }))
);

type BuilderTab = 'code' | 'runs' | 'schedules';

const HOOK_MENTION_TRIGGER_OPTIONS = HOOK_EVENT_NAMES.map((trigger) => ({
  value: trigger,
  label: HOOK_TRIGGER_LABELS[trigger],
}));

type CodeLoadState =
  | { status: 'loading' }
  | { status: 'loaded' }
  | { status: 'error'; message: string };

/**
 * What a save attempt actually did. `blocked` means hook.ts changed on disk
 * and the conflict is on screen — callers must not read that as success,
 * and must not close the panel on it.
 */
type PersistOutcome =
  | { status: 'clean' }
  | { status: 'saved'; workspace: HookWorkspaceInfo }
  | { status: 'blocked' };

interface HookBuilderPanelProps {
  mode: 'create' | 'edit';
  hook?: HookWorkspaceInfo;
  onClose: () => void;
  onSaved: (hook: HookWorkspaceInfo) => void;
}

/**
 * Code-first editor for one saved hook workspace. `hook.ts` is the only
 * configuration authority: triggers, filters, actions, and dynamic content
 * references are authored in the file rather than mirrored through a form.
 * The only structured control left is the folder name when creating a hook,
 * because a file cannot be persisted without a workspace id.
 */
export const HookBuilderPanel: FC<HookBuilderPanelProps> = ({ mode, hook, onClose, onSaved }) => {
  const editing = mode === 'edit';
  const hookName = editing ? (hook?.hookName ?? null) : null;
  const [newHookName, setNewHookName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<BuilderTab>('code');
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [loadedCode, setLoadedCode] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [codeLoad, setCodeLoad] = useState<CodeLoadState>(() =>
    editing ? { status: 'loading' } : { status: 'loaded' }
  );
  const [codeRetryNonce, setCodeRetryNonce] = useState(0);
  // Registration row drives the enable/disable control. `null` = not registered
  // yet (the folder scanner hasn't picked the hook up), which is a normal state
  // right after a create — the control stays hidden rather than lying.
  const [registration, setRegistration] = useState<HookRegistrationInfo | null>(null);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [runAsError, setRunAsError] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);

  useEffect(() => {
    if (!editing) nameRef.current?.focus();
  }, [editing]);

  // Registration is separate from the file: a hook can be saved and building
  // yet not registered, so a 404 here is expected rather than an error state.
  useEffect(() => {
    if (!editing || !hookName) return;
    let canceled = false;
    hooksWorkspacesApi
      .status(hookName)
      .then((row) => {
        if (!canceled) setRegistration(row);
      })
      .catch(() => {
        if (!canceled) setRegistration(null);
      });
    return () => {
      canceled = true;
    };
  }, [editing, hookName]);

  // The Hooks sidebar, the CLI or another window can flip the same flag.
  useEffect(() => {
    if (!hookName) return;
    return onLibraryEvent((event) => {
      if (event.type !== 'hook-enabled-changed' || event.hookName !== hookName) return;
      setRegistration((current) =>
        current && current.enabled !== event.enabled
          ? { ...current, enabled: event.enabled }
          : current
      );
    });
  }, [hookName]);

  const handleToggleEnabled = useCallback(async () => {
    if (!hookName || !registration || togglingEnabled) return;
    const next = !registration.enabled;
    setTogglingEnabled(true);
    setEnableError(null);
    try {
      const row = await hooksWorkspacesApi.setEnabled(hookName, next);
      setRegistration(row);
      emitLibraryEvent({ type: 'hook-enabled-changed', hookName, enabled: row.enabled });
    } catch (err) {
      setEnableError(getErrorMessage(err, `Couldn't ${next ? 'enable' : 'disable'} this script`));
    } finally {
      setTogglingEnabled(false);
    }
  }, [hookName, registration, togglingEnabled]);

  // What a run this hook wakes does with a tool call that would ask a person
  // (nobody is there). Saved as it changes, like Enable.
  const handlePolicyChange = useCallback(
    async (value: string) => {
      if (!hookName || !registration || savingPolicy || !isUnattendedPolicy(value)) return;
      if (value === registration.unattendedPolicy) return;
      setSavingPolicy(true);
      setEnableError(null);
      try {
        setRegistration(await hooksWorkspacesApi.setUnattendedPolicy(hookName, value));
      } catch (err) {
        setEnableError(getErrorMessage(err, "Couldn't change what unattended runs do"));
      } finally {
        setSavingPolicy(false);
      }
    },
    [hookName, registration, savingPolicy]
  );

  useEffect(() => {
    if (!editing || !hookName) return;
    let canceled = false;
    setCodeLoad({ status: 'loading' });
    hooksWorkspacesApi
      .readFile(hookName, 'hook.ts')
      .then((content) => {
        if (canceled) return;
        setLoadedCode(content);
        setCodeTouched(false);
        setManualCode('');
        setCodeLoad({ status: 'loaded' });
      })
      .catch((err: unknown) => {
        if (canceled) return;
        if (err instanceof FetchError && err.status === 404) {
          setLoadedCode('');
          setCodeLoad({ status: 'loaded' });
          return;
        }
        setCodeLoad({
          status: 'error',
          message: getErrorMessage(err, 'the read failed'),
        });
      });
    return () => {
      canceled = true;
    };
  }, [editing, hookName, codeRetryNonce]);

  const createScaffold = useMemo(
    () => scaffoldHookTs(newHookName.trim(), ['message:create'], ''),
    [newHookName]
  );
  const persistedCode = editing ? (loadedCode ?? '') : '';
  const codeBaseline = editing ? persistedCode : createScaffold;
  const code = codeTouched ? manualCode : codeBaseline;
  const codeDirty = codeLoad.status === 'loaded' && code !== persistedCode;
  // The buffer as of the last render, for a save that resolves after more typing.
  const codeRef = useRef(code);
  codeRef.current = code;

  const handleCodeChange = useCallback(
    (next: string) => {
      if (next === codeBaseline) {
        setCodeTouched(false);
        setManualCode('');
        return;
      }
      setCodeTouched(true);
      setManualCode(next);
    },
    [codeBaseline]
  );

  // A fresh read of hook.ts, normalizing "absent" the same way the initial
  // load does — a 404 means the file is gone, not that the read failed.
  const readHookFile = useCallback(async (): Promise<string> => {
    if (!hookName) return '';
    try {
      return await hooksWorkspacesApi.readFile(hookName, 'hook.ts');
    } catch (err) {
      if (err instanceof FetchError && err.status === 404) return '';
      throw err;
    }
  }, [hookName]);

  const adoptDiskCode = useCallback((disk: string) => {
    setLoadedCode(disk);
    setCodeTouched(false);
    setManualCode('');
  }, []);

  // hook.ts is not written only here — an agent handed the work in a
  // thread writes it directly. See useExternalFileChange.
  const {
    conflict: externalConflict,
    check: checkExternalChange,
    keepMine,
    reloadFromDisk,
  } = useExternalFileChange({
    enabled: editing && Boolean(hookName) && codeLoad.status === 'loaded',
    read: readHookFile,
    baseline: persistedCode,
    buffer: code,
    onAdopt: adoptDiskCode,
    onRebaseline: setLoadedCode,
  });

  /**
   * Persist a dirty hook.ts through the normal save path and re-baseline the
   * editor. Shared by Save-and-close and by the test console's save-then-run
   * flow.
   *
   * Re-reads the file first: `updateFiles` is a full-file overwrite, so a
   * hook.ts that moved since it was loaded has to raise the conflict rather
   * than be clobbered by a buffer that never saw it.
   */
  const persistDirtyCode = useCallback(async (): Promise<PersistOutcome> => {
    if (!editing || !hookName || !codeDirty) return { status: 'clean' };
    const externalVerdict = await checkExternalChange();
    if (externalVerdict === 'conflict') return { status: 'blocked' };
    if (externalVerdict === 'unavailable') {
      throw new Error(
        "Couldn't re-read hook.ts before saving. Your edits are still here; try again when the file is available."
      );
    }
    const result = await hooksWorkspacesApi.updateFiles(hookName, { 'hook.ts': code });
    // The test console saves with the editor still open: typing that landed
    // while the write was going stays, unsaved against what was written.
    const typed = codeRef.current;
    setLoadedCode(code);
    setCodeTouched(typed !== code);
    setManualCode(typed === code ? '' : typed);
    return { status: 'saved', workspace: result.workspace };
  }, [editing, hookName, codeDirty, code, checkExternalChange]);

  /**
   * The test console's pre-run save: the run endpoint executes saved code
   * only, so any in-editor changes are written first (and announced through
   * onSaved so the host list stays in sync) — without closing the panel.
   */
  const ensureSavedForTest = useCallback(async () => {
    if (codeLoad.status !== 'loaded') {
      throw new Error('hook.ts has not finished loading');
    }
    const outcome = await persistDirtyCode();
    if (outcome.status === 'blocked') {
      // Surfaces as a failed console entry (BuilderTestConsole's runFlow
      // catch) rather than running the wrong code.
      throw new Error(
        'hook.ts changed on disk — resolve the external change above before running a test.'
      );
    }
    if (outcome.status === 'saved') onSaved(outcome.workspace);
  }, [codeLoad.status, persistDirtyCode, onSaved]);

  const handleSubmit = useCallback(async () => {
    if (codeLoad.status !== 'loaded') return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      if (editing) {
        if (!hookName || !hook) {
          setSubmitError('This script has no folder to save to.');
          return;
        }
        const outcome = await persistDirtyCode();
        if (outcome.status === 'blocked') {
          // The notice lives in the Code tab; make sure that's what's showing,
          // otherwise Save would appear to do nothing at all.
          setActiveTab('code');
          return;
        }
        onSaved(outcome.status === 'saved' ? outcome.workspace : hook);
        onClose();
        return;
      }

      const name = newHookName.trim();
      const validationError = validateHookName(name);
      setNameError(validationError);
      if (validationError) return;
      const result = await hooksWorkspacesApi.save(name, { 'hook.ts': code });
      onSaved(result.workspace);
      onClose();
    } catch (err) {
      setSubmitError(getErrorMessage(err, "Couldn't save the script"));
    } finally {
      setSubmitting(false);
    }
  }, [
    codeLoad.status,
    editing,
    hookName,
    hook,
    persistDirtyCode,
    code,
    newHookName,
    onSaved,
    onClose,
  ]);

  // The discard prompt uses the in-app ConfirmModal, not window.confirm: the
  // Tauri webview suppresses native dialogs (they return falsy unseen). As in
  // ToolBuilderPanel, the in-flight edit is reset before onClose because some
  // hosts (HookBuilderView) treat onClose as a no-op and keep this mounted.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const handleRequestClose = useCallback(() => {
    if (submitting) return;
    if (codeDirty) {
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  }, [submitting, codeDirty, onClose]);
  const handleConfirmDiscard = useCallback(() => {
    setConfirmingDiscard(false);
    setCodeTouched(false);
    setManualCode('');
    onClose();
  }, [onClose]);

  return (
    <div className={styles.pane}>
      <div className={styles.paneHeader}>
        <span className={styles.paneTitle}>{editing ? hookName : 'New script'}</span>
        {registration && hookName && (
          <HookRunAsControl
            hookName={hookName}
            runAsAgentId={registration.runAsAgentId ?? null}
            onSaved={setRegistration}
            onError={setRunAsError}
          />
        )}
        {registration && (
          <span className={styles.enableControl}>
            <span
              className={registration.enabled ? styles.enabledDot : styles.disabledDot}
              aria-hidden="true"
            />
            <span className={styles.enabledLabel}>
              {registration.enabled ? 'Enabled' : 'Disabled'}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleToggleEnabled()}
              loading={togglingEnabled}
              loadingText={registration.enabled ? 'Disabling…' : 'Enabling…'}
              title={
                registration.enabled
                  ? 'Stop automatic event and schedule runs. The script stays saved and still runs from the test console.'
                  : 'Let this script run automatically on its declared events and schedules.'
              }
            >
              {registration.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Select
              size="sm"
              value={registration.unattendedPolicy ?? 'skip'}
              onChange={(e) => void handlePolicyChange(e.target.value)}
              disabled={savingPolicy}
              aria-label="Tool calls that ask for a person, in runs this script wakes"
              title={UNATTENDED_POLICY_HINT}
            >
              {UNATTENDED_POLICY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </span>
        )}
      </div>
      {enableError && (
        <pre className={styles.formError} role="alert">
          {enableError}
        </pre>
      )}
      {runAsError && (
        <pre className={styles.formError} role="alert">
          {runAsError}
        </pre>
      )}
      <div className={`${styles.paneBody} ${activeTab === 'code' ? styles.paneBodyCode : ''}`}>
        {editing && codeLoad.status === 'loading' ? (
          <p className={styles.loading}>Loading script…</p>
        ) : (
          <>
            {editing && (
              <Tabs
                value={activeTab}
                onChange={(next) => setActiveTab(next as BuilderTab)}
                className={styles.tabs}
                aria-label="Script editor sections"
              >
                <Tabs.Tab value="code">
                  Code
                  {codeDirty && (
                    <span
                      className={styles.tabDirtyDot}
                      aria-hidden="true"
                      title="Unsaved changes"
                    />
                  )}
                </Tabs.Tab>
                <Tabs.Tab value="runs">Runs</Tabs.Tab>
                <Tabs.Tab value="schedules">Schedules</Tabs.Tab>
              </Tabs>
            )}

            {activeTab === 'runs' && hookName ? (
              <HookRunsPanel hookName={hookName} />
            ) : activeTab === 'schedules' && hookName ? (
              <HookSchedulesPanel hookName={hookName} />
            ) : (
              <div className={styles.codeSection}>
                {!editing && (
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Script name</span>
                    <TextInput
                      ref={nameRef}
                      fullWidth
                      value={newHookName}
                      onChange={(event) => setNewHookName(event.target.value)}
                      placeholder="my-script"
                      disabled={submitting}
                      aria-label="Script name"
                    />
                    {nameError && <span className={styles.fieldErrorText}>{nameError}</span>}
                  </label>
                )}
                {codeLoad.status === 'error' ? (
                  <>
                    <pre className={styles.formError} role="alert">
                      {`Couldn't load hook.ts: ${codeLoad.message}\nCode editing is disabled — saving now would overwrite the file with content that never loaded.`}
                    </pre>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={styles.codeRetryBtn}
                      onClick={() => setCodeRetryNonce((nonce) => nonce + 1)}
                      disabled={submitting}
                    >
                      Retry loading hook.ts
                    </Button>
                  </>
                ) : (
                  <>
                    <div className={styles.codeSectionHeader}>
                      <span className={styles.fieldHint}>
                        hook.ts is the source of truth for triggers, filters, and behavior.
                      </span>
                      {codeDirty && <span className={styles.codeDirtyLabel}>Unsaved</span>}
                    </div>
                    {externalConflict && (
                      <BuilderExternalChangeNotice
                        fileName="hook.ts"
                        disk={externalConflict.disk}
                        onReloadFromDisk={reloadFromDisk}
                        onKeepMine={keepMine}
                        disabled={submitting}
                      />
                    )}
                    {editing && hookName && (
                      <HookTestConsole
                        hookName={hookName}
                        code={code}
                        ensureSaved={ensureSavedForTest}
                        disabled={submitting}
                      />
                    )}
                    <Suspense fallback={<div className={styles.codeLoading}>Loading editor…</div>}>
                      <HandlerEditor
                        value={code}
                        onChange={handleCodeChange}
                        readOnly={submitting}
                        enableNodeMentions
                        mentionTriggerOptions={HOOK_MENTION_TRIGGER_OPTIONS}
                        enableDropInsert
                        fillHeight
                        aria-label="hook.ts observer code"
                      />
                    </Suspense>
                    {!hasDefaultExport(code) && (
                      <p className={styles.codeExportHint} role="status">
                        No `export default` found — this script won't register until one is
                        restored.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
            {submitError && (
              <pre className={styles.formError} role="alert">
                {submitError}
              </pre>
            )}
          </>
        )}
      </div>
      <div className={styles.paneFooter}>
        <Button variant="ghost" size="md" onClick={handleRequestClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          onClick={handleSubmit}
          loading={submitting}
          loadingText={editing ? 'Saving…' : 'Creating…'}
          disabled={codeLoad.status !== 'loaded'}
        >
          {editing ? 'Save changes' : 'Create script'}
        </Button>
      </div>
      {confirmingDiscard && (
        <ConfirmModal
          title="Discard unsaved changes?"
          confirmLabel="Discard changes"
          destructive
          onConfirm={handleConfirmDiscard}
          onCancel={() => setConfirmingDiscard(false)}
        >
          Your unsaved edits to hook.ts will be lost.
        </ConfirmModal>
      )}
    </div>
  );
};
