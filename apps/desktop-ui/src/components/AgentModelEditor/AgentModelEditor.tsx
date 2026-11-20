import { useCallback, useEffect, useMemo, useState, type FC } from 'react';
import { modelOptionLabels } from '@snaglet/shared/utils';
import { refreshModelData, useModelData } from '@desktop/components/ModelSelector/ModelSelector';
import { Select } from '@desktop/components/controls';

import styles from './AgentModelEditor.module.scss';
import { getErrorMessage } from '@snaglet/shared/utils';

export interface AgentModelEditorValue {
  providerId: string | null;
  modelId: string | null;
  credentialId: string | null;
  /** Only meaningful when the consumer renders the fallback toggle
   *  (`showFallbackToggle`). When true, a provider error fails the turn
   *  loudly instead of retrying on the next candidate model. */
  disableFallback?: boolean;
}

interface AgentModelEditorProps {
  /** Current persisted value. The editor will reseed its pending state
   *  whenever any field of `value` changes (so external refresh works). */
  value: AgentModelEditorValue;
  /** Optional fallback (e.g. the agent's own defaults) used to *prefill*
   *  the dropdowns when `value` has nulls. Purely a display concern:
   *  - dirty baseline becomes `value.X ?? fallback.X`, so submitting an
   *    untouched prefill is a no-op (Save stays disabled) and does not
   *    create a phantom override.
   *  - `hasOverride` (Reset button visibility) is still driven by raw
   *    `value`, so Reset only shows when there's an actual override.
   *  When undefined, null fields render blank. */
  fallback?: AgentModelEditorValue;
  /** Persist callback. Receives the full pending triple. Should throw on
   *  failure (the component catches and renders the error inline). */
  onSave: (next: AgentModelEditorValue) => Promise<void>;
  /** When true, the editor permits `null` ("inherit / use default") for
   *  each field and renders a "Reset to default" button when any field
   *  is non-null. When false (e.g. editing an agent's own defaults),
   *  fields cannot be cleared back to null — there is no upstream default
   *  to inherit from. */
  allowNull?: boolean;
  /** Optional label shown in the editor header (e.g. "Thread override",
   *  "Agent default"). Defaults to no label. */
  headerLabel?: string;
  /** Optional slot rendered next to the header label (e.g. an "OVERRIDE"
   *  tag in the thread case). */
  headerSlot?: React.ReactNode;
  /** Optional empty-option label for the provider select. Defaults to
   *  "— inherit —" when allowNull, otherwise hidden. */
  emptyOptionLabel?: string;
  /** When true, renders a "Disable model fallback" checkbox that rides
   *  the same pending/dirty/Save flow as the selects. The current state
   *  comes from `value.disableFallback` and is persisted via `onSave`. */
  showFallbackToggle?: boolean;
  /** Auto-save mode. When true the Save button is dropped and each select
   *  persists immediately on change (a select is a discrete choice, not a
   *  keystroke, so there's nothing to debounce). Provider changes are the
   *  one exception: they reset model+credential to null, so the save waits
   *  until a model is chosen rather than persisting a model-less agent.
   *  Save state + errors still surface inline; a failed save keeps the
   *  pending selection so the user can re-pick to retry. Default false
   *  preserves the manual-Save behavior for the thread-override consumer. */
  autosave?: boolean;
}

const FLASH_MS = 1800;
const KEYLESS_PROVIDER_IDS = new Set(['ollama', 'lm-studio', 'apple-on-device']);

/** Shared editor for provider / model / credential selection.
 *
 *  Two consumers today:
 *    - ChatSettings: thread-scoped participant override (allowNull=true)
 *    - AgentView:    global agent defaults             (allowNull=false)
 *
 *  Component is presentational — the caller owns persistence (`onSave`)
 *  and decides what "clear" means for its target row.
 */
export const AgentModelEditor: FC<AgentModelEditorProps> = ({
  value,
  fallback,
  onSave,
  allowNull = false,
  headerLabel,
  headerSlot,
  emptyOptionLabel,
  showFallbackToggle: _showFallbackToggle = false,
  autosave = false,
}) => {
  const { providers, models, credentials, loading } = useModelData();

  // The provider's declared primary credential — what the run path
  // (resolveCredentialIdForModel) actually uses when no credential is pinned.
  // Serves as the display/seed default for the credential select so "no pin"
  // never renders as an empty field. Validated against the loaded credential
  // rows so a stale pointer can't select a ghost.
  const resolvePrimaryCredentialId = useCallback(
    (providerId: string | null): string | null => {
      if (!providerId) return null;
      const primaryId =
        providers.find((candidate) => candidate.id === providerId)?.primaryCredentialId ?? null;
      const primaryExists = credentials.some(
        (credential) => credential.id === primaryId && credential.providerId === providerId
      );
      return primaryExists ? primaryId : null;
    },
    [providers, credentials]
  );

  // Baseline for both pending-state seeding and dirty detection. When
  // a participant override exists for a field, use it; otherwise fall
  // back to the agent's own default so the dropdowns display the value
  // the thread will actually use. `hasOverride` (Reset visibility) still
  // keys on raw `value` further down, so prefill never lies about state.
  const baselineProviderId = value.providerId ?? fallback?.providerId ?? null;
  const baselineModelId = value.modelId ?? fallback?.modelId ?? null;
  // With no explicit or inherited credential, the baseline resolves to the
  // provider's primary credential — the auto-selection the server applies at
  // run time, made visible (and persisted alongside the user's next edit).
  const baselineCredentialId =
    value.credentialId ?? fallback?.credentialId ?? resolvePrimaryCredentialId(baselineProviderId);
  const baselineDisableFallback = value.disableFallback ?? fallback?.disableFallback ?? false;

  const [pendingProviderId, setPendingProviderId] = useState<string | null>(baselineProviderId);
  const [pendingModelId, setPendingModelId] = useState<string | null>(baselineModelId);
  const [pendingCredentialId, setPendingCredentialId] = useState<string | null>(
    baselineCredentialId
  );
  const [pendingDisableFallback, setPendingDisableFallback] =
    useState<boolean>(baselineDisableFallback);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Reseed pending state whenever the persisted value OR fallback changes
  // (e.g. caller refreshes the underlying record, agent selection changes,
  // or the agent's own defaults are edited from another surface).
  useEffect(() => {
    setPendingProviderId(baselineProviderId);
    setPendingModelId(baselineModelId);
    setPendingCredentialId(baselineCredentialId);
    setPendingDisableFallback(baselineDisableFallback);
    setError(null);
    setSavedAt(null);
  }, [baselineProviderId, baselineModelId, baselineCredentialId, baselineDisableFallback]);

  // Auto-dismiss "saved" indicator.
  useEffect(() => {
    if (savedAt === null) return;
    const t = window.setTimeout(() => setSavedAt(null), FLASH_MS);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  // Dirty is relative to the *baseline* (value-or-fallback). This means
  // saving the prefilled defaults as-is is a no-op (Save disabled) and
  // does not create a phantom override on the participant record.
  const dirty =
    pendingProviderId !== baselineProviderId ||
    pendingModelId !== baselineModelId ||
    pendingCredentialId !== baselineCredentialId ||
    pendingDisableFallback !== baselineDisableFallback;

  // hasOverride keys on raw `value` only — so the Reset button only
  // appears when there's an *actual* persisted override, never just
  // because the fallback prefilled non-null values.
  const hasOverride =
    value.providerId !== null || value.modelId !== null || value.credentialId !== null;

  // Filter models/credentials to those matching the chosen provider.
  // When provider is null we show everything (rare in practice — mostly
  // useful in the "inherit" case so users can still see what's available).
  const modelsForProvider = useMemo(
    () => (pendingProviderId ? models.filter((m) => m.providerId === pendingProviderId) : models),
    [models, pendingProviderId]
  );
  // The list arrives in picker order; two models that share a display name
  // (an alias and its dated snapshot) get distinct labels.
  const modelLabels = useMemo(() => modelOptionLabels(modelsForProvider), [modelsForProvider]);
  const credentialsForProvider = useMemo(
    () =>
      pendingProviderId
        ? credentials.filter((c) => c.providerId === pendingProviderId)
        : credentials,
    [credentials, pendingProviderId]
  );
  const credentialRequired =
    pendingProviderId !== null && !KEYLESS_PROVIDER_IDS.has(pendingProviderId);
  const missingRequiredCredential = credentialRequired && pendingCredentialId === null;

  // Persist an explicit triple immediately (auto-save mode). Reads its
  // argument rather than pending state so a select's onChange can save the
  // value it just chose without waiting for the state update to flush.
  const persist = useCallback(
    async (next: AgentModelEditorValue) => {
      setSaving(true);
      setError(null);
      try {
        await onSave(next);
        setSavedAt(Date.now());
      } catch (err) {
        // Keep the pending selection so the user can re-pick to retry.
        setError(getErrorMessage(err, 'Save failed'));
      } finally {
        setSaving(false);
      }
    },
    [onSave]
  );

  // Soft metadata check: the per-request output
  const handleProviderChange = useCallback(
    (next: string | null) => {
      setPendingProviderId(next);
      // Another provider's models may have been imported since the last read.
      refreshModelData();
      // A provider change invalidates the model and atomically selects that
      // provider's declared primary credential. Never carry a credential across
      // providers, and never guess from the most recently updated credential.
      setPendingModelId(null);
      setPendingCredentialId(resolvePrimaryCredentialId(next));
      // In auto-save mode we intentionally do NOT persist here: model just
      // reset to null, and writing a provider with no model would leave the
      // agent model-less. The save fires when a model is chosen below.
    },
    [resolvePrimaryCredentialId]
  );

  const handleModelChange = useCallback(
    (next: string | null) => {
      setPendingModelId(next);
      if (autosave) {
        void persist({
          providerId: pendingProviderId,
          modelId: next,
          credentialId: pendingCredentialId,
          disableFallback: pendingDisableFallback,
        });
      }
    },
    [autosave, persist, pendingProviderId, pendingCredentialId, pendingDisableFallback]
  );

  const handleCredentialChange = useCallback(
    (next: string | null) => {
      setPendingCredentialId(next);
      refreshModelData();
      // Same rule as a provider change: with no model picked yet, saving
      // would write a model-less agent. The credential rides along with the
      // model save instead.
      if (autosave && pendingModelId !== null) {
        void persist({
          providerId: pendingProviderId,
          modelId: pendingModelId,
          credentialId: next,
          disableFallback: pendingDisableFallback,
        });
      }
    },
    [autosave, persist, pendingProviderId, pendingModelId, pendingDisableFallback]
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        providerId: pendingProviderId,
        modelId: pendingModelId,
        credentialId: pendingCredentialId,
        disableFallback: pendingDisableFallback,
      });
      setSavedAt(Date.now());
    } catch (err) {
      setError(getErrorMessage(err, 'Save failed'));
    } finally {
      setSaving(false);
    }
  }, [onSave, pendingProviderId, pendingModelId, pendingCredentialId, pendingDisableFallback]);

  const handleReset = useCallback(async () => {
    // Reset clears the override and persists immediately, mirroring the
    // old ChatSettings UX. Only available when allowNull. The PERSISTED value
    // is null (inherit); the pending fields reseed from the fallback so the
    // selects display what "default" actually resolves to — the inherited
    // provider/model and its effective credential — never blank inputs.
    // (Without this, an override equal to the fallback left the fields empty
    // after reset because the baseline never changed to retrigger reseeding.)
    const fallbackProviderId = fallback?.providerId ?? null;
    setPendingProviderId(fallbackProviderId);
    setPendingModelId(fallback?.modelId ?? null);
    setPendingCredentialId(
      fallback?.credentialId ?? resolvePrimaryCredentialId(fallbackProviderId)
    );
    setPendingDisableFallback(fallback?.disableFallback ?? false);
    setSaving(true);
    setError(null);
    try {
      await onSave({ providerId: null, modelId: null, credentialId: null, disableFallback: false });
      setSavedAt(Date.now());
    } catch (err) {
      setError(getErrorMessage(err, 'Reset failed'));
    } finally {
      setSaving(false);
    }
  }, [onSave, fallback, resolvePrimaryCredentialId]);

  const inheritLabel = emptyOptionLabel ?? '— inherit —';

  return (
    <div className={styles.modelEditor}>
      {(headerLabel || headerSlot) && (
        <div className={styles.modelEditorHeader}>
          {headerLabel && <span className={styles.modelEditorHeaderLabel}>{headerLabel}</span>}
          {headerSlot}
        </div>
      )}

      <div className={styles.modelEditorGrid}>
        <label className={styles.modelEditorField}>
          <span className={styles.modelEditorLabel}>Provider</span>
          <Select
            value={pendingProviderId ?? ''}
            disabled={loading || saving}
            onChange={(e) => handleProviderChange(e.target.value === '' ? null : e.target.value)}
          >
            {allowNull && <option value="">{inheritLabel}</option>}
            {!allowNull && pendingProviderId === null && (
              <option value="" disabled>
                Select provider…
              </option>
            )}
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.id}
              </option>
            ))}
          </Select>
        </label>

        <label className={styles.modelEditorField}>
          <span className={styles.modelEditorLabel}>Model</span>
          <Select
            value={pendingModelId ?? ''}
            disabled={loading || saving || pendingProviderId === null || missingRequiredCredential}
            onChange={(e) => handleModelChange(e.target.value === '' ? null : e.target.value)}
          >
            {allowNull && <option value="">{inheritLabel}</option>}
            {!allowNull && pendingModelId === null && (
              <option value="" disabled>
                Select model…
              </option>
            )}
            {modelsForProvider.map((m, index) => {
              // The option value is `m.modelId` (upstream identifier
              // like "gpt-4o"), not `m.id` (row PK). This is what gets
              // persisted to agent.modelId / participant.modelId.
              // Plan-blocked models stay selectable (pinnable) — a native
              // <option> can't hold a badge, so the label carries the note.
              const planBlocked = m.metadata?.entitlement?.status === 'plan_blocked';
              const label = modelLabels[index] ?? m.modelId;
              return (
                <option key={m.id} value={m.modelId}>
                  {planBlocked ? `${label} — not on your plan` : label}
                </option>
              );
            })}
          </Select>
        </label>
      </div>

      {pendingProviderId !== null && (
        <label className={styles.modelEditorField}>
          <span className={styles.modelEditorLabel}>Credential</span>
          <Select
            value={pendingCredentialId ?? ''}
            disabled={loading || saving || pendingProviderId === null}
            onChange={(e) => handleCredentialChange(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">
              {credentialsForProvider.length === 0
                ? 'No saved credential for this provider'
                : 'Select credential…'}
            </option>
            {credentialsForProvider.map((c) => {
              // Badge the provider's primary credential — it is what runs
              // whenever no credential is explicitly chosen, so the label
              // should say so wherever it appears.
              const isPrimary = c.id === resolvePrimaryCredentialId(pendingProviderId);
              const label = c.label || c.id;
              return (
                <option key={c.id} value={c.id}>
                  {isPrimary ? `${label} (primary)` : label}
                </option>
              );
            })}
          </Select>
        </label>
      )}

      <div className={styles.modelEditorActions}>
        {!autosave && (
          <button
            type="button"
            className={styles.saveBtn}
            disabled={!dirty || saving || loading || missingRequiredCredential}
            onClick={handleSave}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
        {allowNull && hasOverride && (
          <button
            type="button"
            className={styles.resetBtn}
            disabled={saving || loading}
            onClick={handleReset}
          >
            Reset to default
          </button>
        )}
        {autosave && saving && <span className={styles.modelEditorStatus}>Saving…</span>}
        {missingRequiredCredential && !error && (
          <span className={styles.modelEditorError}>
            Save a credential for this provider before choosing a model
          </span>
        )}
        {savedAt !== null && !saving && <span className={styles.modelEditorStatus}>Saved</span>}
        {error && <span className={styles.modelEditorError}>{error}</span>}
      </div>
    </div>
  );
};
