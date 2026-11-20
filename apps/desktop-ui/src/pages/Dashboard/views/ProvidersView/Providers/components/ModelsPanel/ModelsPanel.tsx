import React, { useEffect, useRef, useState } from 'react';
import type { ModelRow, ModelMetadata, BulkModelInput, DiscoveryResult } from '@desktop/utils/api';
import { Button, TextInput, Stack, Cluster } from '@desktop/components';
import { Chip } from '@desktop/components/Chip';
import styles from './ModelsPanel.module.scss';
import { DiscoverPanel } from './DiscoverPanel';

export interface AddModelInput {
  modelId: string;
  displayName?: string;
  metadata?: ModelMetadata;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
}

interface UpdateModelInput {
  displayName?: string;
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
}

interface ModelsPanelProps {
  providerId: string;
  models: ModelRow[];
  usedModelIds: Set<string>;
  /** Resolve false when the change was refused, so the form keeps what was typed. */
  onAddModel: (input: AddModelInput) => Promise<boolean>;
  onUpdateModel: (modelId: string, input: UpdateModelInput) => Promise<boolean>;
  onRemoveModel: (modelId: string) => void;
  onDiscoverModels: (providerId: string) => Promise<DiscoveryResult>;
  onImportModels: (providerId: string, models: BulkModelInput[]) => Promise<boolean>;
  /** Database model-row id to center and briefly highlight after sidebar navigation. */
  focusModelId?: string | null;
  /** A failed model change to show here, since the panel's own actions are otherwise silent. */
  error?: string | null;
}

interface FormState {
  modelId: string;
  displayName: string;
  contextWindowTokens: string;
  maxOutputTokens: string;
  tokenBudgetRatio: string;
  tailMessages: string;
}

/** A model id in the form each local server uses, for the Model ID placeholder. */
const LOCAL_MODEL_ID_EXAMPLES: Readonly<Record<string, string>> = {
  ollama: 'llama3.2',
  'lm-studio': 'llama-3.2-3b-instruct',
};

function modelIdPlaceholder(providerId: string): string {
  return `Model ID (e.g. ${LOCAL_MODEL_ID_EXAMPLES[providerId] ?? 'claude-sonnet-4-5'})`;
}

const EMPTY_FORM: FormState = {
  modelId: '',
  displayName: '',
  contextWindowTokens: '',
  maxOutputTokens: '',
  tokenBudgetRatio: '',
  tailMessages: '',
};

interface EditFormState {
  displayName: string;
  contextWindowTokens: string;
  maxOutputTokens: string;
}

function hasModelMetadata(meta: ModelMetadata | undefined): boolean {
  if (!meta) return false;
  const cc = meta.contextCompression;
  const sm = meta.summary;
  return Boolean(
    (cc && Object.values(cc).some((v) => v !== undefined && v !== null)) ||
    (sm && Object.values(sm).some((v) => v !== undefined && v !== null))
  );
}

function toNumberOrUndefined(s: string): number | undefined {
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function buildInput(form: FormState): AddModelInput | null {
  const modelId = form.modelId.trim();
  if (!modelId) return null;

  const tokenBudgetRatio = toNumberOrUndefined(form.tokenBudgetRatio);
  const tailMessages = toNumberOrUndefined(form.tailMessages);
  const contextWindowTokens = toNumberOrUndefined(form.contextWindowTokens);
  const maxOutputTokens = toNumberOrUndefined(form.maxOutputTokens);

  const cc: Record<string, number> = {};
  if (tokenBudgetRatio !== undefined) cc.tokenBudgetRatio = tokenBudgetRatio;
  if (tailMessages !== undefined) cc.tailMessages = tailMessages;

  const metadata: ModelMetadata = {};
  if (Object.keys(cc).length > 0) metadata.contextCompression = cc;

  return {
    modelId,
    displayName: form.displayName.trim() || undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    contextWindowTokens: contextWindowTokens ?? null,
    maxOutputTokens: maxOutputTokens ?? null,
  };
}

export const ModelsPanel: React.FC<ModelsPanelProps> = ({
  providerId,
  models,
  usedModelIds,
  onAddModel,
  onUpdateModel,
  onRemoveModel,
  onDiscoverModels,
  onImportModels,
  focusModelId = null,
  error = null,
}) => {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [expanded, setExpanded] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [highlightedModelId, setHighlightedModelId] = useState<string | null>(null);
  const modelRefs = useRef(new Map<string, HTMLDivElement>());
  const [editForm, setEditForm] = useState<EditFormState>({
    displayName: '',
    contextWindowTokens: '',
    maxOutputTokens: '',
  });

  useEffect(() => {
    if (!focusModelId) return;
    const card = modelRefs.current.get(focusModelId);
    if (!card) return;

    card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    setHighlightedModelId(focusModelId);
    const timer = window.setTimeout(() => setHighlightedModelId(null), 1800);
    return () => window.clearTimeout(timer);
  }, [focusModelId, models]);

  const patch = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleAdd = async () => {
    const input = buildInput(form);
    if (!input) return;
    // Keep what was typed until the add is saved, so a refused add can be retried.
    if (!(await onAddModel(input))) return;
    setForm(EMPTY_FORM);
    setExpanded(false);
  };

  const startEdit = (model: ModelRow) => {
    setEditingModelId(model.id);
    setEditForm({
      displayName: model.displayName || model.modelId,
      contextWindowTokens: model.contextWindowTokens?.toString() ?? '',
      maxOutputTokens: model.maxOutputTokens?.toString() ?? '',
    });
  };

  const patchEdit = <K extends keyof EditFormState>(key: K, value: EditFormState[K]) =>
    setEditForm((prev) => ({ ...prev, [key]: value }));

  const handleSaveEdit = async (model: ModelRow) => {
    const contextWindowTokens = toNumberOrUndefined(editForm.contextWindowTokens);
    const maxOutputTokens = toNumberOrUndefined(editForm.maxOutputTokens);
    const saved = await onUpdateModel(model.id, {
      displayName: editForm.displayName.trim() || model.modelId,
      contextWindowTokens: contextWindowTokens ?? null,
      maxOutputTokens: maxOutputTokens ?? null,
    });
    // A refused update leaves the edit open with the typed values.
    if (saved) setEditingModelId(null);
  };

  const modelIdField = (
    <label className={styles.fieldLabel}>
      Model ID
      <TextInput
        type="text"
        fullWidth
        placeholder={modelIdPlaceholder(providerId)}
        value={form.modelId}
        onChange={(e) => patch('modelId', e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !expanded && handleAdd()}
      />
    </label>
  );

  return (
    <div className={styles.panel}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <Stack gap={2} className={styles.controls}>
        {/* Keyed on providerId so React unmounts the panel when the user
            switches provider — clears discovered list + refresh-metadata
            note so they can't be misattributed to the new provider. */}
        <DiscoverPanel
          key={providerId}
          providerId={providerId}
          onDiscover={onDiscoverModels}
          onImport={onImportModels}
          onRemoveModels={async (ids) => {
            for (const id of ids) {
              await onRemoveModel(id);
            }
          }}
        />

        {/* The "Add custom model" form. Provider-bound, no credential
            selector. */}
        <div className={styles.customSection}>
          <button
            type="button"
            className={styles.customToggle}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            <span className={styles.customToggleIcon} aria-hidden="true">
              {expanded ? '−' : '+'}
            </span>
            Add custom model
          </button>

          {expanded ? (
            <div className={styles.customCard} role="group" aria-label="Custom model details">
              <p className={styles.customHelp}>
                Fill in the details Snaglet can’t discover automatically for this provider.
              </p>
              {modelIdField}

              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel}>
                  Display name
                  <TextInput
                    type="text"
                    fullWidth
                    placeholder="Shown to users"
                    value={form.displayName}
                    onChange={(e) => patch('displayName', e.target.value)}
                  />
                </label>
              </div>

              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel}>
                  Context window (tokens)
                  <TextInput
                    type="number"
                    fullWidth
                    placeholder="e.g. 200000"
                    value={form.contextWindowTokens}
                    onChange={(e) => patch('contextWindowTokens', e.target.value)}
                  />
                </label>
                <label className={styles.fieldLabel}>
                  Max output (tokens)
                  <TextInput
                    type="number"
                    fullWidth
                    placeholder="e.g. 8192"
                    value={form.maxOutputTokens}
                    onChange={(e) => patch('maxOutputTokens', e.target.value)}
                  />
                </label>
              </div>

              <div className={styles.sectionLabel}>
                Compression overrides — leave blank to use provider defaults
              </div>
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel}>
                  Token budget ratio (0–1)
                  <TextInput
                    type="number"
                    fullWidth
                    step="0.05"
                    placeholder="e.g. 0.6"
                    value={form.tokenBudgetRatio}
                    onChange={(e) => patch('tokenBudgetRatio', e.target.value)}
                  />
                </label>
                <label className={styles.fieldLabel}>
                  Tail messages (kept verbatim)
                  <TextInput
                    type="number"
                    fullWidth
                    placeholder="e.g. 10"
                    value={form.tailMessages}
                    onChange={(e) => patch('tailMessages', e.target.value)}
                  />
                </label>
              </div>

              <Cluster justify="end">
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleAdd}
                  disabled={!form.modelId.trim()}
                >
                  Add model
                </Button>
              </Cluster>
            </div>
          ) : (
            <div className={styles.addForm}>
              {modelIdField}
              <Button
                variant="neutral"
                size="md"
                onClick={handleAdd}
                disabled={!form.modelId.trim()}
              >
                Add
              </Button>
            </div>
          )}
        </div>
      </Stack>

      <div className={styles.scrollArea}>
        {models.length === 0 ? (
          <p className={styles.emptyState}>No models for this provider.</p>
        ) : (
          <div className={styles.grid}>
            {models.map((model) => {
              const isUsed = usedModelIds.has(model.modelId);
              const hasMeta = hasModelMetadata(model.metadata);
              const isEditing = editingModelId === model.id;
              return (
                <div
                  key={model.id}
                  ref={(element) => {
                    if (element) modelRefs.current.set(model.id, element);
                    else modelRefs.current.delete(model.id);
                  }}
                  className={`${styles.card} ${
                    highlightedModelId === model.id ? styles.cardFocused : ''
                  }`}
                  data-model-id={model.id}
                  data-used={isUsed || undefined}
                >
                  <div className={styles.cardTop}>
                    <span className={styles.cardName}>{model.displayName || model.modelId}</span>
                    <div className={styles.cardActions}>
                      <Button
                        variant="ghost"
                        size="xs"
                        className={styles.cardActionBtn}
                        onClick={() => (isEditing ? setEditingModelId(null) : startEdit(model))}
                      >
                        {isEditing ? 'Cancel' : 'Edit'}
                      </Button>
                      <Button
                        variant="danger"
                        size="xs"
                        iconOnly
                        className={styles.removeBtn}
                        onClick={() => onRemoveModel(model.id)}
                        aria-label="Remove model"
                      >
                        &times;
                      </Button>
                    </div>
                  </div>
                  <span className={styles.cardModelId}>{model.modelId}</span>
                  {isEditing ? (
                    <div className={styles.editModelForm}>
                      <label className={styles.fieldLabel}>
                        Display name
                        <TextInput
                          type="text"
                          fullWidth
                          value={editForm.displayName}
                          onChange={(e) => patchEdit('displayName', e.target.value)}
                        />
                      </label>
                      <label className={styles.fieldLabel}>
                        Context window
                        <TextInput
                          type="number"
                          fullWidth
                          placeholder="tokens"
                          value={editForm.contextWindowTokens}
                          onChange={(e) => patchEdit('contextWindowTokens', e.target.value)}
                        />
                      </label>
                      <label className={styles.fieldLabel}>
                        Max output
                        <TextInput
                          type="number"
                          fullWidth
                          placeholder="tokens"
                          value={editForm.maxOutputTokens}
                          onChange={(e) => patchEdit('maxOutputTokens', e.target.value)}
                        />
                      </label>
                      <Button variant="neutral" size="sm" onClick={() => handleSaveEdit(model)}>
                        Save
                      </Button>
                    </div>
                  ) : model.description ? (
                    <span className={styles.cardDesc}>{model.description}</span>
                  ) : null}
                  <div className={styles.cardMeta}>
                    {model.contextWindowTokens && (
                      <Chip size="xs" tone="muted">
                        {Math.round(model.contextWindowTokens / 1024)}k ctx
                      </Chip>
                    )}
                    {model.maxOutputTokens && (
                      <Chip size="xs" tone="muted">
                        {Math.round(model.maxOutputTokens / 1024)}k out
                      </Chip>
                    )}
                    {model.supportsTools && (
                      <Chip size="xs" tone="muted">
                        tools
                      </Chip>
                    )}
                    {model.supportsVision && (
                      <Chip size="xs" tone="muted">
                        vision
                      </Chip>
                    )}
                    {model.supportsReasoning && (
                      <Chip size="xs" tone="muted">
                        reasoning
                      </Chip>
                    )}
                    {model.metadata?.entitlement?.status === 'plan_blocked' && (
                      <Chip
                        size="xs"
                        tone="error"
                        title={
                          model.metadata.entitlement.reason ?? 'Not included in your Copilot plan'
                        }
                      >
                        not on your plan
                      </Chip>
                    )}
                    {!hasMeta && (
                      <Chip size="xs" tone="muted" variant="dashed">
                        provider defaults
                      </Chip>
                    )}
                    {isUsed && (
                      <Chip size="xs" tone="primary">
                        in use
                      </Chip>
                    )}
                  </div>
                  {/* Plan-blocked models stay at full opacity and remain
                      pinnable — the red chip flags it, this calm gold strip
                      explains why in plain language. */}
                  {model.metadata?.entitlement?.status === 'plan_blocked' && (
                    <p className={styles.reasonStrip}>
                      {model.metadata.entitlement.reason ??
                        'Not included in your current Copilot plan. You can still pin it — requests may be rejected until your plan covers it.'}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
