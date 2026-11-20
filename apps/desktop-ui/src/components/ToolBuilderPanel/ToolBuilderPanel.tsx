import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { Button, Select, Tabs, Textarea, TextInput } from '@desktop/components';
import { ConfirmModal } from '@desktop/components/Modal';
import {
  FetchError,
  toolWorkspacesApi,
  type ToolRow,
  type WorkspaceFiles,
} from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import { BuilderExternalChangeNotice, useExternalFileChange } from '../BuilderExternalChange';
import { ParamsSchemaEditor } from './ParamsSchemaEditor';
import { ToolTestConsole } from './ToolTestConsole';
import { hasDefaultExport } from '../HandlerEditor/handlerEditorSupport';
import {
  buildDefinitionJson,
  buildParametersSchema,
  DEFAULT_CATEGORY_PATH,
  DEFAULT_TIER,
  formatDeployFailure,
  parseDefinition,
  scaffoldToolMd,
  scaffoldToolTs,
  toolIdFromSource,
  TOOL_TIERS,
  validateToolName,
  type ParamFieldRow,
  type ToolBuilderFormState,
  type ToolTier,
} from './scaffold';
import styles from './ToolBuilderPanel.module.scss';

// The CodeMirror-based editor is the heaviest thing this panel can
// pull in — deferred to its own chunk and only fetched once the user actually
// opens the Code tab, so creating/editing a tool from the Details tab alone
// (the common path) never downloads it.
const HandlerEditor = lazy(() =>
  import('../HandlerEditor/HandlerEditor').then((mod) => ({ default: mod.HandlerEditor }))
);

type BuilderTab = 'details' | 'code';

/**
 * The Code tab's own load lifecycle, independent of the metadata load.
 * 'loaded' is the only state that renders the editor and the only state in
 * which `codeDirty` can become true — so a failed tool.ts read can never be
 * mistaken for an empty file and silently overwritten on save (updateFiles
 * is a full-file overwrite server-side). Create mode starts 'loaded' (the
 * baseline is the generated scaffold; there is nothing to fetch).
 */
type CodeLoadState =
  | { status: 'loading' }
  | { status: 'loaded' }
  | { status: 'error'; message: string };

interface ToolBuilderPanelProps {
  mode: 'create' | 'edit';
  /** Required when mode === 'edit' — the workspace-sourced tool being edited. */
  tool?: ToolRow;
  /**
   * Called on Cancel (and, once dirty, only after the discard confirm is
   * accepted). The caller decides what "leaving" means for its host. Any
   * in-flight code edits are reset locally first (see `handleRequestClose`)
   * so a host that treats this as a no-op still visibly discards them.
   */
  onClose: () => void;
  /** Called with the created/updated tool row right before onClose fires. */
  onSaved: (tool: ToolRow) => void;
}

function emptyForm(): ToolBuilderFormState {
  return {
    name: '',
    description: '',
    categoryPath: DEFAULT_CATEGORY_PATH,
    tier: DEFAULT_TIER,
    keywords: [],
    paramRows: [],
    unrepresentableSchema: null,
  };
}

function keywordsFromText(text: string): string[] {
  return text
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * Create/edit form for a workspace tool, written through `toolWorkspacesApi`.
 * Hosted by ToolPane, with a Details tab (metadata) and a lazy Code tab
 * (HandlerEditor over tool.ts), and one Save.
 *
 * Create saves the files, then deploys. Edit includes tool.ts only when the
 * Code tab is dirty, and deploys after a code save. Build failures keep the
 * panel open. The name is read-only in edit mode because it is the folder id.
 */
export const ToolBuilderPanel: FC<ToolBuilderPanelProps> = ({ mode, tool, onClose, onSaved }) => {
  const editing = mode === 'edit';
  const toolId = editing ? toolIdFromSource(tool?.source) : null;

  const [form, setForm] = useState<ToolBuilderFormState>(emptyForm);
  const [keywordsText, setKeywordsText] = useState('');
  const [loadingExisting, setLoadingExisting] = useState(editing);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<BuilderTab>('details');
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Code tab state
  // `loadedCode` is the fetched tool.ts baseline in edit mode (null until
  // the code-load effect below resolves; irrelevant in create mode).
  // `manualCode` + `codeTouched` capture the user's own edits once they've
  // opened the Code tab and typed — before that, the effective code just
  // follows whatever it would default to (the loaded file, or — in create
  // mode — the live scaffold for the current name, so typing the name keeps
  // the untouched preview in sync, matching scaffoldToolTs(name) exactly at
  // submit time).
  const [loadedCode, setLoadedCode] = useState<string | null>(null);
  const [codeTouched, setCodeTouched] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [codeLoad, setCodeLoad] = useState<CodeLoadState>(() =>
    editing ? { status: 'loading' } : { status: 'loaded' }
  );
  // Bumped by the Retry button on a failed tool.ts read — re-runs the
  // code-load effect without re-fetching the (already loaded) definition.
  const [codeRetryNonce, setCodeRetryNonce] = useState(0);

  const liveScaffoldCode = useMemo(() => scaffoldToolTs(form.name.trim()), [form.name]);
  // The `?? ''` is a type-narrowing fallback, not a reachable editing state:
  // the editor only renders when `codeLoad.status === 'loaded'`, and edit
  // mode only reaches that status after `setLoadedCode(...)` ran (see the
  // code-load effect). So the user can never type against an empty baseline
  // while the real tool.ts is still in flight or failed to load. Keep that
  // status gating if the render structure changes.
  const codeBaseline = editing ? (loadedCode ?? '') : liveScaffoldCode;
  const code = codeTouched ? manualCode : codeBaseline;
  // Only a successfully-loaded Code tab can be dirty — while loading or
  // errored the editor isn't rendered and Save must stay metadata-only.
  // Edit mode compares against the loaded file so reverting text back to the
  // original clears the flag; create mode only cares whether the user has
  // ever diverged from the live scaffold (there's no server baseline yet).
  const codeDirty =
    codeLoad.status === 'loaded' &&
    (editing ? code !== codeBaseline : codeTouched && code !== liveScaffoldCode);

  const handleCodeChange = useCallback(
    (next: string) => {
      if (next === codeBaseline) {
        // The edit brought the text back to the baseline, so resume following
        // it. In create mode this keeps the scaffold tracking the tool name
        // after the user edits and then reverts the code.
        setCodeTouched(false);
        setManualCode('');
        return;
      }
      setCodeTouched(true);
      setManualCode(next);
    },
    [codeBaseline]
  );

  // A fresh read of tool.ts, normalizing "absent" exactly the way the initial
  // code-load effect below does — a 404 means the file is genuinely gone.
  const readToolFile = useCallback(async (): Promise<string> => {
    if (!toolId) return '';
    try {
      return await toolWorkspacesApi.readFile(toolId, 'tool.ts');
    } catch (err) {
      if (err instanceof FetchError && err.status === 404) return '';
      throw err;
    }
  }, [toolId]);

  const adoptDiskCode = useCallback((disk: string) => {
    setLoadedCode(disk);
    setCodeTouched(false);
    setManualCode('');
  }, []);

  // tool.ts is not written only here — an agent handed the work in a
  // thread writes it directly. See useExternalFileChange.
  const {
    conflict: externalConflict,
    check: checkExternalChange,
    keepMine,
    reloadFromDisk,
  } = useExternalFileChange({
    enabled: editing && Boolean(toolId) && codeLoad.status === 'loaded',
    read: readToolFile,
    baseline: codeBaseline,
    buffer: code,
    onAdopt: adoptDiskCode,
    onRebaseline: setLoadedCode,
  });

  useEffect(() => {
    if (!editing) {
      nameRef.current?.focus();
      return;
    }
    if (!toolId) {
      setLoadError('This tool has no workspace folder to edit.');
      setLoadingExisting(false);
      return;
    }
    let canceled = false;
    toolWorkspacesApi
      .get(toolId)
      .then((info) => {
        if (canceled) return;
        const next = parseDefinition(info.definition);
        setForm(next);
        setKeywordsText(next.keywords.join(', '));
      })
      .catch((err) => {
        if (!canceled) setLoadError(getErrorMessage(err, 'Failed to load tool'));
      })
      .finally(() => {
        if (!canceled) setLoadingExisting(false);
      });
    return () => {
      canceled = true;
    };
  }, [editing, toolId]);

  // Code-tab load — independent of the definition load above so a tool.ts
  // problem never takes down metadata editing, and vice versa.
  // The status machine is the data-loss guard: only a 404 (file absent)
  // becomes "start empty". Any other failure lands in 'error' and blocks the
  // editor, so a failed read can never be saved over the real tool.ts.
  useEffect(() => {
    if (!editing || !toolId) return;
    let canceled = false;
    setCodeLoad({ status: 'loading' });
    toolWorkspacesApi
      .readFile(toolId, 'tool.ts')
      .then((content) => {
        if (canceled) return;
        setLoadedCode(content);
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
          message: getErrorMessage(err, 'Failed to load tool.ts'),
        });
      });
    return () => {
      canceled = true;
    };
  }, [editing, toolId, codeRetryNonce]);

  const setParamRows = useCallback((rows: ParamFieldRow[]) => {
    setForm((prev) => ({ ...prev, paramRows: rows }));
  }, []);

  // The schema the test console seeds its args editor from — exactly what a
  // save would write into definition.json (hand-authored unrepresentable
  // schemas pass through untouched, same as buildDefinitionJson).
  const testParametersSchema = useMemo(
    () => form.unrepresentableSchema ?? buildParametersSchema(form.paramRows),
    [form.unrepresentableSchema, form.paramRows]
  );

  const handleKeywordsChange = useCallback((text: string) => {
    setKeywordsText(text);
    setForm((prev) => ({ ...prev, keywords: keywordsFromText(text) }));
  }, []);

  const handleSubmit = useCallback(async () => {
    const nameErr = validateToolName(form.name);
    setNameError(nameErr);
    if (nameErr) return;

    setSubmitError(null);
    setSubmitting(true);
    try {
      if (editing) {
        if (!toolId) {
          setSubmitError('This tool has no workspace folder to save to.');
          return;
        }
        const files: Partial<WorkspaceFiles> = { 'definition.json': buildDefinitionJson(form) };
        if (codeDirty) {
          // updateFiles is a full-file overwrite, so tool.ts is only included
          // after confirming it hasn't moved underneath us. A metadata-only
          // save never touches the file and needs no check.
          const externalVerdict = await checkExternalChange();
          if (externalVerdict === 'conflict') {
            // The notice lives in the Code tab; without this a Save pressed
            // from Details would appear to do nothing at all.
            setActiveTab('code');
            return;
          }
          if (externalVerdict === 'unavailable') {
            setActiveTab('code');
            setSubmitError(
              'Could not re-read tool.ts before saving. Your edits are still here; try again when the file is available.'
            );
            return;
          }
          files['tool.ts'] = code;
        }

        const result = await toolWorkspacesApi.updateFiles(toolId, files);
        if (!result.tool) {
          setSubmitError('Save succeeded but the server did not return the updated tool.');
          return;
        }

        if (!codeDirty) {
          onSaved(result.tool);
          onClose();
          return;
        }

        // The write succeeded even if the deploy below fails, so move the
        // baseline: the "Unsaved" flag must match what is on disk.
        setLoadedCode(code);

        // Writing the file does not rebuild it. `deploy` runs esbuild and
        // reactivates the tool, and reports build errors. It also re-syncs
        // definition.json, which updateFiles already did; the repeat is
        // harmless.
        const deployResult = await toolWorkspacesApi.deploy(toolId);
        if (!deployResult.success) {
          setSubmitError(formatDeployFailure(deployResult));
          return;
        }
        onSaved(deployResult.tool);
        onClose();
        return;
      }

      const name = form.name.trim();
      const files = {
        'definition.json': buildDefinitionJson(form),
        'tool.ts': code,
        'TOOL.md': scaffoldToolMd(name, form.description),
      };
      await toolWorkspacesApi.save(name, files);
      const deployResult = await toolWorkspacesApi.deploy(name);
      if (!deployResult.success) {
        setSubmitError(formatDeployFailure(deployResult));
        return;
      }
      onSaved(deployResult.tool);
      onClose();
    } catch (err) {
      setSubmitError(getErrorMessage(err, 'Failed to save tool'));
    } finally {
      setSubmitting(false);
    }
  }, [editing, toolId, form, code, codeDirty, checkExternalChange, onSaved, onClose]);

  // The discard prompt guards unsaved code only, not metadata. It uses the
  // in-app ConfirmModal because the Tauri webview suppresses window.confirm.
  // The code edit is reset before `onClose`, since some hosts treat
  // `onClose` as a no-op and keep this component mounted.
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
        {editing ? `Edit ${tool?.name ?? 'tool'}` : 'New tool'}
      </div>
      <div className={styles.paneBody}>
        {loadingExisting ? (
          <p className={styles.loading}>Loading tool…</p>
        ) : (
          <>
            {loadError && (
              <p className={styles.formError} role="alert">
                {loadError}
              </p>
            )}

            <Tabs
              value={activeTab}
              onChange={(next) => setActiveTab(next as BuilderTab)}
              className={styles.tabs}
              aria-label="Tool editor sections"
            >
              <Tabs.Tab value="details">Details</Tabs.Tab>
              <Tabs.Tab value="code">
                Code
                {codeDirty && (
                  // Decorative only — aria-hidden so it doesn't get folded
                  // into the tab's accessible name ("Code Unsaved code
                  // changes"). The always-visible "Unsaved" label in the
                  // Code section header below is the real AT-accessible
                  // dirty signal.
                  <span
                    className={styles.tabDirtyDot}
                    aria-hidden="true"
                    title="Unsaved code changes"
                  />
                )}
              </Tabs.Tab>
            </Tabs>

            {activeTab === 'code' ? (
              <div className={styles.codeSection}>
                {codeLoad.status === 'error' ? (
                  <>
                    <pre className={styles.formError} role="alert">
                      {`Couldn't load tool.ts: ${codeLoad.message}\nCode editing is disabled — saving now would overwrite the file with content that never loaded. Metadata changes can still be saved.`}
                    </pre>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={styles.codeRetryBtn}
                      onClick={() => setCodeRetryNonce((nonce) => nonce + 1)}
                      disabled={submitting}
                    >
                      Retry loading tool.ts
                    </Button>
                  </>
                ) : codeLoad.status === 'loading' ? (
                  <div className={styles.codeLoading}>Loading tool.ts…</div>
                ) : (
                  <>
                    <div className={styles.codeSectionHeader}>
                      <span className={styles.fieldHint}>
                        tool.ts — the handler Snaglet calls when this tool runs.
                      </span>
                      {codeDirty && <span className={styles.codeDirtyLabel}>Unsaved</span>}
                    </div>
                    {externalConflict && (
                      <BuilderExternalChangeNotice
                        fileName="tool.ts"
                        disk={externalConflict.disk}
                        onReloadFromDisk={reloadFromDisk}
                        onKeepMine={keepMine}
                        disabled={submitting}
                      />
                    )}
                    <ToolTestConsole
                      toolName={toolId ?? form.name.trim()}
                      code={code}
                      parametersSchema={testParametersSchema}
                      disabled={submitting}
                    />
                    <Suspense fallback={<div className={styles.codeLoading}>Loading editor…</div>}>
                      <HandlerEditor
                        value={code}
                        onChange={handleCodeChange}
                        readOnly={submitting}
                        enableNodeMentions
                        enableDropInsert
                        fillHeight
                        aria-label="tool.ts handler code"
                      />
                    </Suspense>
                    {!hasDefaultExport(code) && (
                      <p className={styles.codeExportHint} role="status">
                        No `export default` found — the build will fail until the handler is
                        exported again.
                      </p>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className={styles.form}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Name</span>
                  <TextInput
                    ref={nameRef}
                    fullWidth
                    value={form.name}
                    onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="my-tool"
                    disabled={editing || submitting}
                    aria-label="Name"
                  />
                  {nameError ? (
                    <span className={styles.fieldErrorText}>{nameError}</span>
                  ) : (
                    <span className={styles.fieldHint}>
                      Folder-safe id (letters, numbers, "-", "_") — becomes the tool's workspace
                      folder.
                    </span>
                  )}
                </label>

                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Description</span>
                  <Textarea
                    value={form.description}
                    rows={2}
                    onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                    placeholder="What does this tool do?"
                    disabled={submitting}
                    aria-label="Description"
                  />
                </label>

                <div className={styles.row}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Category</span>
                    <TextInput
                      fullWidth
                      value={form.categoryPath}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, categoryPath: e.target.value }))
                      }
                      placeholder={DEFAULT_CATEGORY_PATH}
                      disabled={submitting}
                      aria-label="Category"
                    />
                  </label>

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Tier</span>
                    <Select
                      value={form.tier}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, tier: e.target.value as ToolTier }))
                      }
                      disabled={submitting}
                      aria-label="Tier"
                    >
                      {TOOL_TIERS.map((tier) => (
                        <option key={tier} value={tier}>
                          {tier}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>

                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Keywords (comma-separated)</span>
                  <TextInput
                    fullWidth
                    value={keywordsText}
                    onChange={(e) => handleKeywordsChange(e.target.value)}
                    placeholder="search, weather"
                    disabled={submitting}
                    aria-label="Keywords"
                  />
                </label>

                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Parameters</span>
                  {form.unrepresentableSchema ? (
                    <div className={styles.schemaPreview}>
                      <p className={styles.fieldHint}>
                        This tool's parameters use a shape the form can't edit (nested objects,
                        typed array items, or another hand-authored JSON-Schema feature) — shown
                        read-only so saving here won't overwrite it. Edit the workspace's
                        definition.json directly to change it.
                      </p>
                      <pre className={styles.schemaPreviewJson}>
                        {JSON.stringify(form.unrepresentableSchema, null, 2)}
                      </pre>
                    </div>
                  ) : (
                    <ParamsSchemaEditor
                      rows={form.paramRows}
                      onChange={setParamRows}
                      disabled={submitting}
                    />
                  )}
                </div>
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
          disabled={loadingExisting || Boolean(loadError)}
        >
          {editing ? 'Save changes' : 'Create tool'}
        </Button>
      </div>
      {confirmingDiscard && (
        <ConfirmModal
          title="Discard unsaved code changes?"
          confirmLabel="Discard changes"
          destructive
          onConfirm={handleConfirmDiscard}
          onCancel={() => setConfirmingDiscard(false)}
        >
          Your edits on the Code tab will be lost.
        </ConfirmModal>
      )}
    </div>
  );
};
