import { useCallback, useEffect, useRef, useState, type FC, type KeyboardEvent } from 'react';
import { projectsApi } from '@desktop/utils/api';
import type { FileIndexingImpact, IndexConfig } from '@desktop/utils/api';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { Button } from '@desktop/components';
import { TextInput } from '@desktop/components/controls/TextInput/TextInput';
import { getErrorMessage } from '@snaglet/shared/utils';
import { isAutoSkippedFileExtension } from '@snaglet/shared/constants';
import styles from './IndexingRulesPanel.module.scss';

const RULE_SAVE_DEBOUNCE_MS = 300;

interface IndexingRulesPanelProps {
  projectId: string;
  /** Bubbled up so the parent "Watch folder edits" toggle reflects on-disk edits
   * (e.g. a hand-edited `embeddings.enabled` read back on load). */
  onConfigLoaded?: (config: IndexConfig) => void;
}

/**
 * IndexingRulesPanel — edits the additive ignore rules in the project folder's
 * `snaglet.config.json` and shows the always-on hardcoded exclusions read-only.
 *
 * User rules (`ignorePaths` / `ignoreFileTypes`) are editable lists. Edits show
 * immediately and rapid changes are saved together through the atomic,
 * key-preserving server endpoint. The built-in denylist is shown grayed-out
 * beneath so it's obvious why `node_modules`, images, etc. never appear — and
 * that user rules extend that list, never relax it.
 */
export const IndexingRulesPanel: FC<IndexingRulesPanelProps> = (props) => (
  <IndexingRulesPanelEditor key={props.projectId} {...props} />
);

const IndexingRulesPanelEditor: FC<IndexingRulesPanelProps> = ({ projectId, onConfigLoaded }) => {
  const [config, setConfig] = useState<IndexConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [impact, setImpact] = useState<FileIndexingImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(true);
  const [impactFailed, setImpactFailed] = useState(false);
  const [newInclude, setNewInclude] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newType, setNewType] = useState('');
  const configRef = useRef<IndexConfig | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlightRef = useRef(false);
  const saveQueuedRef = useRef(false);
  const revisionRef = useRef(0);
  const persistLatestRef = useRef<() => void>(() => {});
  const activeProjectRef = useRef(projectId);
  const impactRequestVersionRef = useRef(0);

  const onConfigLoadedRef = useRef(onConfigLoaded);
  onConfigLoadedRef.current = onConfigLoaded;

  useEffect(() => {
    let canceled = false;
    activeProjectRef.current = projectId;
    configRef.current = null;
    saveQueuedRef.current = false;
    revisionRef.current = 0;
    setLoading(true);
    setError(null);
    projectsApi
      .getIndexConfig(projectId)
      .then((cfg) => {
        if (canceled) return;
        configRef.current = cfg;
        setConfig(cfg);
        onConfigLoadedRef.current?.(cfg);
      })
      .catch((err) => {
        if (!canceled) setError(getErrorMessage(err, 'Could not load indexing settings'));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      if (activeProjectRef.current === projectId) activeProjectRef.current = '';
      // Closing the panel must not discard the last few rapid-fire edits.
      if (saveQueuedRef.current) persistLatestRef.current();
    };
  }, [projectId]);

  const refreshImpact = useCallback(async () => {
    const requestVersion = ++impactRequestVersionRef.current;
    setImpactLoading(true);
    setImpactFailed(false);
    try {
      const next = await projectsApi.getFileIndexingImpact(projectId);
      if (impactRequestVersionRef.current !== requestVersion) return;
      setImpact(next);
      setImpactLoading(false);
    } catch {
      if (impactRequestVersionRef.current !== requestVersion) return;
      setImpactFailed(true);
      setImpactLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refreshImpact();
    const unsubscribe = onLibraryEvent((event) => {
      if (event.type !== 'file-indexing-impact-changed' || event.projectId !== projectId) return;
      impactRequestVersionRef.current += 1;
      setImpact({
        eligibleFiles: event.eligibleFiles,
        scannedEntries: event.scannedEntries,
        capped: event.capped,
      });
      setImpactFailed(false);
      setImpactLoading(false);
    });
    return unsubscribe;
  }, [projectId, refreshImpact]);

  const persistLatest = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (saveInFlightRef.current || !saveQueuedRef.current) return;

    const snapshot = configRef.current;
    if (!snapshot) return;
    const savedRevision = revisionRef.current;
    saveQueuedRef.current = false;
    saveInFlightRef.current = true;
    if (activeProjectRef.current === projectId) {
      setSaving(true);
      setError(null);
    }
    try {
      const serverConfig = await projectsApi.updateIndexConfig(projectId, {
        includePaths: snapshot.includePaths,
        ignorePaths: snapshot.ignorePaths,
        ignoreFileTypes: snapshot.ignoreFileTypes,
      });
      // A disabled project has no reconcile owner and therefore emits no scan
      // event. Refresh once on demand; enabled projects reuse the reconcile scan.
      if (!serverConfig.enabled && activeProjectRef.current === projectId) {
        void refreshImpact();
      }
      // A response for an older burst must not overwrite chips added while the
      // request was in flight. The next save carries the complete latest lists.
      if (activeProjectRef.current === projectId && revisionRef.current === savedRevision) {
        configRef.current = serverConfig;
        setConfig(serverConfig);
        onConfigLoadedRef.current?.(serverConfig);
      }
    } catch (err) {
      if (activeProjectRef.current === projectId) {
        setError(getErrorMessage(err, 'Could not save indexing settings'));
        setImpactLoading(false);
      }
    } finally {
      saveInFlightRef.current = false;
      if (saveQueuedRef.current) {
        persistLatestRef.current();
      } else if (activeProjectRef.current === projectId) {
        setSaving(false);
      }
    }
  }, [projectId, refreshImpact]);
  persistLatestRef.current = () => void persistLatest();

  const queueConfig = useCallback((next: IndexConfig) => {
    configRef.current = next;
    revisionRef.current += 1;
    saveQueuedRef.current = true;
    setConfig(next);
    setSaving(true);
    impactRequestVersionRef.current += 1;
    setImpactLoading(true);
    setImpactFailed(false);
    setError(null);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => persistLatestRef.current(), RULE_SAVE_DEBOUNCE_MS);
  }, []);

  const updateRules = useCallback(
    (update: (current: IndexConfig) => IndexConfig) => {
      const current = configRef.current;
      if (!current) return;
      queueConfig(update(current));
    },
    [queueConfig]
  );

  const addPath = useCallback(() => {
    const value = newPath.trim();
    const current = configRef.current;
    if (!value || !current) return;
    if (current.ignorePaths.includes(value)) {
      setNewPath('');
      return;
    }
    updateRules((cfg) => ({ ...cfg, ignorePaths: [...cfg.ignorePaths, value] }));
    setNewPath('');
  }, [newPath, updateRules]);

  const addInclude = useCallback(() => {
    const value = newInclude.trim();
    const current = configRef.current;
    if (!value || !current) return;
    if (current.includePaths.includes(value)) {
      setNewInclude('');
      return;
    }
    updateRules((cfg) => ({ ...cfg, includePaths: [...cfg.includePaths, value] }));
    setNewInclude('');
  }, [newInclude, updateRules]);

  const addType = useCallback(() => {
    const value = newType.trim().replace(/^\./, '').toLowerCase();
    const current = configRef.current;
    if (!value || !current) return;
    // Binary / non-text types are already always auto-skipped — don't let the
    // user re-add one as a redundant, removable rule (that's the clutter this
    // panel is meant to avoid). Silently drop it; the built-in area explains why.
    if (isAutoSkippedFileExtension(value)) {
      setNewType('');
      return;
    }
    if (current.ignoreFileTypes.includes(value)) {
      setNewType('');
      return;
    }
    updateRules((cfg) => ({ ...cfg, ignoreFileTypes: [...cfg.ignoreFileTypes, value] }));
    setNewType('');
  }, [newType, updateRules]);

  const removePath = useCallback(
    (value: string) => {
      updateRules((cfg) => ({ ...cfg, ignorePaths: cfg.ignorePaths.filter((p) => p !== value) }));
    },
    [updateRules]
  );

  const removeInclude = useCallback(
    (value: string) => {
      updateRules((cfg) => ({
        ...cfg,
        includePaths: cfg.includePaths.filter((p) => p !== value),
      }));
    },
    [updateRules]
  );

  const removeType = useCallback(
    (value: string) => {
      updateRules((cfg) => ({
        ...cfg,
        ignoreFileTypes: cfg.ignoreFileTypes.filter((t) => t !== value),
      }));
    },
    [updateRules]
  );

  const onEnterAdd = (handler: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handler();
    }
  };

  if (loading) {
    return (
      <div className={styles.indexingPanel}>
        <div className={styles.indexingHint}>Loading indexing settings…</div>
      </div>
    );
  }

  if (error && !config) {
    return (
      <div className={styles.indexingPanel}>
        <div className={styles.errorBanner}>{error}</div>
      </div>
    );
  }

  if (!config) return null;

  const disabled = config.parseError;

  // Binary / non-text extensions are always auto-skipped by the server, so they
  // must never appear as user-removable chips — even if an old stored config
  // still lists them in `ignoreFileTypes`. Show only genuinely-custom (text-ish)
  // types the user chose; the auto-skipped ones are surfaced read-only below.
  const customFileTypes = config.ignoreFileTypes.filter((t) => !isAutoSkippedFileExtension(t));

  return (
    <div className={styles.indexingPanel}>
      {config.parseError && (
        <div className={styles.warningBanner} role="status">
          snaglet.config.json is not valid JSON. Fix it by hand before editing indexing rules here.
        </div>
      )}
      {!config.configExists && (
        <div className={styles.indexingHint}>
          No snaglet.config.json yet — it will be created in the project folder on your first
          change.
        </div>
      )}
      {error && config && <div className={styles.errorBanner}>{error}</div>}
      <div className={styles.indexingSaveStatus} role="status" aria-live="polite">
        {saving
          ? 'Saving rules… You can keep adding more.'
          : 'Add several rules quickly — Snaglet saves them together and updates the index in the background.'}
      </div>

      <div className={styles.indexingImpact} aria-live="polite">
        <span className={styles.indexingImpactLabel}>Index footprint</span>
        <span className={styles.indexingImpactValue}>
          {impactLoading
            ? 'Recalculating file set…'
            : impactFailed
              ? 'Estimate unavailable'
              : `${(impact?.eligibleFiles ?? 0).toLocaleString()} eligible files`}
        </span>
        {!impactLoading && impact && (
          <span className={styles.indexingImpactMeta}>
            {(impact.capped ? 'At least ' : '') + impact.scannedEntries.toLocaleString()} entries
            scanned{impact.capped ? ' · 50,000-entry safety cap reached' : ''}
          </span>
        )}
      </div>

      <RuleSection
        label="Only include paths"
        hint="Optional allowlist. When empty, all paths are eligible. Add roots or globs such as src, docs, apps/*/src, or **/*.md. Ignore rules below still win."
        items={config.includePaths}
        onRemove={removeInclude}
        disabled={disabled}
        inputValue={newInclude}
        onInputChange={setNewInclude}
        onAdd={addInclude}
        placeholder="src"
        onKeyDown={onEnterAdd(addInclude)}
        emptyLabel="All paths are eligible."
      />

      <RuleSection
        label="Ignore paths"
        hint="Paths are relative to the project folder. Use ** to match at any depth (e.g. dist, **/generated, **/*.snap, or **/fixtures/cache)."
        items={config.ignorePaths}
        onRemove={removePath}
        disabled={disabled}
        inputValue={newPath}
        onInputChange={setNewPath}
        onAdd={addPath}
        placeholder="**/generated"
        onKeyDown={onEnterAdd(addPath)}
        emptyLabel="No custom path rules."
      />

      <RuleSection
        label="Ignore file types"
        hint="Custom text-based extensions to skip (with or without the dot, e.g. csv). Non-text files (images, PDFs, Office documents, etc.) are skipped automatically — no need to add them."
        items={customFileTypes}
        onRemove={removeType}
        disabled={disabled}
        inputValue={newType}
        onInputChange={setNewType}
        onAdd={addType}
        placeholder="csv"
        onKeyDown={onEnterAdd(addType)}
        emptyLabel="No custom file-type rules."
      />

      <div className={styles.indexingSection}>
        <span className={styles.indexingSectionLabel}>Always excluded (built-in)</span>
        <p className={styles.indexingHint}>
          Applied to every project and can’t be turned off. Your rules above are added on top.
        </p>
        <DefaultsGroup title="Folders" items={config.defaults.dirs} />
        <DefaultsGroup title="Filenames" items={config.defaults.filenames} />
        <DefaultsGroup title="File types" items={config.defaults.extensions} />
        <p className={styles.indexingHint}>
          Non-text files (images, PDFs, Office documents, etc.) are automatically skipped.
        </p>
        <p className={styles.indexingHint}>Dotfiles and dot-folders are always skipped too.</p>
      </div>
    </div>
  );
};

interface RuleSectionProps {
  label: string;
  hint: string;
  items: string[];
  onRemove: (value: string) => void;
  disabled: boolean;
  inputValue: string;
  onInputChange: (value: string) => void;
  onAdd: () => void;
  placeholder: string;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  emptyLabel: string;
}

const RuleSection: FC<RuleSectionProps> = ({
  label,
  hint,
  items,
  onRemove,
  disabled,
  inputValue,
  onInputChange,
  onAdd,
  placeholder,
  onKeyDown,
  emptyLabel,
}) => (
  <div className={styles.indexingSection}>
    <span className={styles.indexingSectionLabel}>{label}</span>
    <p className={styles.indexingHint}>{hint}</p>
    {items.length === 0 ? (
      <div className={styles.indexingEmpty}>{emptyLabel}</div>
    ) : (
      <ul className={styles.ruleList}>
        {items.map((item) => (
          <li key={item} className={styles.ruleChip}>
            <span className={styles.ruleChipLabel} title={item}>
              {item}
            </span>
            <button
              type="button"
              className={styles.ruleRemove}
              aria-label={`Remove ${item}`}
              disabled={disabled}
              onClick={() => onRemove(item)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    )}
    <div className={styles.ruleAddRow}>
      <TextInput
        inputSize="sm"
        fullWidth
        value={inputValue}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label={`Add ${label.toLowerCase()}`}
      />
      <Button
        variant="neutral"
        size="sm"
        disabled={disabled || inputValue.trim().length === 0}
        onClick={onAdd}
      >
        Add
      </Button>
    </div>
  </div>
);

const DefaultsGroup: FC<{ title: string; items: string[] }> = ({ title, items }) => {
  if (items.length === 0) return null;
  return (
    <div className={styles.defaultsGroup}>
      <span className={styles.defaultsGroupTitle}>{title}</span>
      <ul className={styles.defaultsList}>
        {items.map((item) => (
          <li key={item} className={styles.defaultChip}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
};
