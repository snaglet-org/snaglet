import React, { useRef, useState } from 'react';
import type { BulkModelInput, DiscoveredModel, DiscoveryResult } from '@desktop/utils/api';
import { Button, Checkbox, Spinner, Stack, Cluster } from '@desktop/components';
import { Chip } from '@desktop/components/Chip';
import styles from './DiscoverPanel.module.scss';
import { getErrorMessage } from '@snaglet/shared/utils';

interface DiscoverPanelProps {
  providerId: string;
  onDiscover: (providerId: string) => Promise<DiscoveryResult>;
  /** Resolves false when the import was refused, so the panel keeps the list for a retry. */
  onImport: (providerId: string, models: BulkModelInput[]) => Promise<boolean>;
  onRemoveModels?: (ids: string[]) => Promise<void>;
}

export const DiscoverPanel: React.FC<DiscoverPanelProps> = ({
  providerId,
  onDiscover,
  onImport,
  onRemoveModels,
}) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [removingStale, setRemovingStale] = useState(false);
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedStale, setSelectedStale] = useState<Set<string>>(new Set());
  const showOllamaStaleModels =
    providerId === 'ollama' && !result?.ollamaNotInstalled && Boolean(result?.staleModels?.length);

  // "Refresh metadata" is a one-click backfill: discover, then auto-import
  // only the models already present in the local registry. Models.bulkUpsert
  // uses `COALESCE(EXCLUDED.x, models.x)` so this is non-destructive —
  // it fills NULL context_window_tokens / max_output_tokens / family on
  // rows that lack them.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'success'; count: number; total: number }
    | { kind: 'error'; message: string }
    | { kind: 'noop' }
  >({ kind: 'idle' });

  // Every discovery takes a ticket. Hiding the list or starting a newer read
  // invalidates the older ones, so a slow read can't overwrite a newer list.
  const discoveryRef = useRef(0);

  const handleToggle = async () => {
    if (open) {
      discoveryRef.current += 1;
      setOpen(false);
      return;
    }
    const ticket = ++discoveryRef.current;
    setOpen(true);
    setLoading(true);
    try {
      const res = await onDiscover(providerId);
      if (ticket !== discoveryRef.current) return;
      setResult(res);
      // Pre-check every not-yet-imported model
      const preselected = new Set(
        res.models.filter((m) => !m.alreadyImported).map((m) => m.modelId)
      );
      setSelected(preselected);
    } finally {
      if (ticket === discoveryRef.current) setLoading(false);
    }
  };

  const toggleOne = (modelId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const selectAll = () => {
    if (!result) return;
    setSelected(new Set(result.models.filter((m) => !m.alreadyImported).map((m) => m.modelId)));
  };

  const clearAll = () => setSelected(new Set());

  const handleImport = async () => {
    if (!result) return;
    const toImport: BulkModelInput[] = result.models
      .filter((m) => selected.has(m.modelId) && !m.alreadyImported)
      .map(toBulkInput);
    if (toImport.length === 0) return;
    setImporting(true);
    try {
      const imported = await onImport(providerId, toImport);
      if (!imported) return;
      setOpen(false);
      setResult(null);
      setSelected(new Set());
    } finally {
      setImporting(false);
    }
  };

  const handleRefreshMetadata = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshStatus({ kind: 'idle' });
    try {
      const res = await onDiscover(providerId);
      const existing = res.models.filter((m) => m.alreadyImported);
      if (existing.length === 0) {
        setRefreshStatus({ kind: 'noop' });
        return;
      }
      const imported = await onImport(providerId, existing.map(toBulkInput));
      if (!imported) {
        setRefreshStatus({ kind: 'error', message: 'the models could not be saved' });
        return;
      }
      setRefreshStatus({ kind: 'success', count: existing.length, total: res.models.length });
    } catch (err) {
      setRefreshStatus({
        kind: 'error',
        message: getErrorMessage(err, 'Refresh failed'),
      });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Stack gap={2}>
      <Cluster gap={2}>
        <Button
          variant="primary"
          size="md"
          onClick={handleToggle}
          loading={loading}
          loadingText="Discovering…"
        >
          {open ? 'Hide discovered' : 'Discover models'}
        </Button>
        <Button
          variant="neutral"
          size="md"
          onClick={handleRefreshMetadata}
          disabled={loading}
          loading={refreshing}
          loadingText="Refreshing…"
          title="Re-fetch model metadata from the provider and backfill any missing context window / output token limits"
        >
          Refresh metadata
        </Button>
      </Cluster>
      {refreshStatus.kind === 'success' && (
        <p className={styles.refreshNote}>
          Refreshed metadata for {refreshStatus.count} model
          {refreshStatus.count === 1 ? '' : 's'}.
        </p>
      )}
      {refreshStatus.kind === 'noop' && (
        <p className={styles.refreshNote}>
          No imported models for this provider yet — use Discover models to add some first.
        </p>
      )}
      {refreshStatus.kind === 'error' && (
        <p className={styles.refreshError}>Refresh failed: {refreshStatus.message}</p>
      )}

      {open && loading && (
        <div className={styles.panel}>
          <div className={styles.loadingState} role="status" aria-live="polite">
            <Spinner size="md" tone="accent" />
            <span className={styles.loadingText}>Fetching available models…</span>
          </div>
        </div>
      )}

      {open && !loading && result && (
        <div className={styles.panel}>
          {result.ollamaNotInstalled ? (
            <div className={styles.ollamaNotInstalled}>
              <p className={styles.ollamaNotInstalledTitle}>Ollama not found</p>
              <p className={styles.ollamaNotInstalledBody}>
                Ollama doesn&apos;t appear to be installed or running on this machine. Install it
                from{' '}
                <a href="https://ollama.com" target="_blank" rel="noreferrer">
                  ollama.com
                </a>{' '}
                then restart the server and try again.
              </p>
            </div>
          ) : result.warning ? (
            <p className={styles.warning}>{result.warning}</p>
          ) : result.models.length === 0 && !showOllamaStaleModels ? (
            <p className={styles.empty}>No models returned by the provider.</p>
          ) : (
            <>
              <Cluster gap={2}>
                <span className={styles.count}>
                  {selected.size} of {result.models.filter((m) => !m.alreadyImported).length}{' '}
                  selected
                </span>
                <Button variant="link" size="sm" onClick={selectAll}>
                  Select all new
                </Button>
                <Button variant="link" size="sm" onClick={clearAll}>
                  Clear
                </Button>
              </Cluster>

              <div className={styles.list}>
                {result.models.map((m) => (
                  <DiscoveredRow
                    key={m.modelId}
                    model={m}
                    checked={m.alreadyImported || selected.has(m.modelId)}
                    disabled={m.alreadyImported}
                    onToggle={() => toggleOne(m.modelId)}
                  />
                ))}
              </div>

              <Cluster justify="end" gap={2}>
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleImport}
                  disabled={selected.size === 0}
                  loading={importing}
                  loadingText="Importing…"
                >
                  Import {selected.size}
                </Button>
              </Cluster>
            </>
          )}
          {showOllamaStaleModels && result.staleModels && (
            <div className={styles.staleSection}>
              <p className={styles.staleTitle}>
                {result.staleModels.length} configured model
                {result.staleModels.length !== 1 ? 's' : ''} not found in Ollama
              </p>
              <p className={styles.staleHint}>
                These models were previously imported but are no longer in your Ollama installation.
                Select the ones you want to remove.
              </p>
              <div className={styles.staleList}>
                {result.staleModels.map((m) => (
                  <Checkbox
                    key={m.id}
                    className={styles.staleRow}
                    checked={selectedStale.has(m.id)}
                    onChange={() =>
                      setSelectedStale((prev) => {
                        const next = new Set(prev);
                        next.has(m.id) ? next.delete(m.id) : next.add(m.id);
                        return next;
                      })
                    }
                  >
                    <span className={styles.staleModelName}>{m.name}</span>
                    <span className={styles.staleModelId}>{m.modelId}</span>
                  </Checkbox>
                ))}
              </div>
              <Cluster justify="end" gap={2}>
                <Button
                  variant="neutral"
                  size="sm"
                  onClick={() =>
                    setSelectedStale(new Set((result.staleModels ?? []).map((m) => m.id)))
                  }
                >
                  Select all stale
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={selectedStale.size === 0 || removingStale || !onRemoveModels}
                  onClick={async () => {
                    if (!onRemoveModels) return;
                    setRemovingStale(true);
                    try {
                      await onRemoveModels(Array.from(selectedStale));
                      const ticket = ++discoveryRef.current;
                      const fresh = await onDiscover(providerId);
                      if (ticket !== discoveryRef.current) return;
                      setResult(fresh);
                      setSelectedStale(new Set());
                    } finally {
                      setRemovingStale(false);
                    }
                  }}
                >
                  {removingStale ? 'Removing…' : `Remove ${selectedStale.size}`}
                </Button>
              </Cluster>
            </div>
          )}
        </div>
      )}
    </Stack>
  );
};

interface DiscoveredRowProps {
  model: DiscoveredModel;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}

const DiscoveredRow: React.FC<DiscoveredRowProps> = ({ model, checked, disabled, onToggle }) => {
  return (
    <Checkbox checked={checked} disabled={disabled} onChange={onToggle} className={styles.row}>
      <div className={styles.rowBody} data-disabled={disabled || undefined}>
        <div className={styles.rowHead}>
          <span className={styles.modelName}>{model.displayName}</span>
          <span className={styles.modelId}>{model.modelId}</span>
        </div>
        <div className={styles.badges}>
          {model.endpointState && (
            <Chip size="xs" tone={model.endpointState === 'STARTED' ? 'success' : 'warning'}>
              {model.endpointState === 'STARTED'
                ? 'endpoint running'
                : `endpoint ${model.endpointState.toLowerCase()}`}
            </Chip>
          )}
          {model.contextWindowTokens && (
            <Chip size="xs" tone="muted">
              {Math.round(model.contextWindowTokens / 1024)}k ctx
            </Chip>
          )}
          {model.family && (
            <Chip size="xs" tone="muted">
              {model.family}
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
          {model.isPreview && (
            <Chip size="xs" tone="warning">
              preview
            </Chip>
          )}
          {model.entitlement?.status === 'plan_blocked' && (
            <Chip
              size="xs"
              tone="error"
              title={model.entitlement.reason ?? 'Not included in your Copilot plan'}
            >
              not on your plan
            </Chip>
          )}
          {model.alreadyImported && (
            <Chip size="xs" tone="muted" variant="dashed">
              already imported
            </Chip>
          )}
        </div>
        {/* Plan-blocked models stay full-opacity and keep an active checkbox
            (pin anyway) — this calm gold strip explains why in plain language. */}
        {model.entitlement?.status === 'plan_blocked' && (
          <p className={styles.reasonStrip}>
            {model.entitlement.reason ??
              'Not in your current Copilot plan — you can still pin it, but requests may be rejected until your plan covers it.'}
          </p>
        )}
      </div>
    </Checkbox>
  );
};

function toBulkInput(m: DiscoveredModel): BulkModelInput {
  return {
    modelId: m.modelId,
    displayName: m.displayName,
    description: m.description,
    family: m.family ?? null,
    contextWindowTokens: m.contextWindowTokens ?? null,
    maxOutputTokens: m.maxOutputTokens ?? null,
    supportsTools: m.supportsTools ?? false,
    supportsVision: m.supportsVision ?? false,
    supportsReasoning: m.supportsReasoning ?? false,
    metadata: m.metadata,
  };
}
