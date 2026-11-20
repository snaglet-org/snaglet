import { useCallback, useEffect, useState, type FC } from 'react';
import type { SemanticStatus, SemanticTableRow } from '@snaglet/shared/types';
import { Button, Switch } from '@desktop/components';
import {
  isSemanticBuilding,
  SEMANTIC_DEFAULT_RULE,
  SemanticConfirm,
  semanticStatusLine,
  useSemanticSwitch,
} from '@desktop/features/database/semanticSearch';
import { useGuardedInterval } from '@desktop/hooks/useGuardedInterval';
import {
  embeddingsApi,
  tablesApi,
  workersApi,
  type EmbeddingMaintenanceModel,
  type EmbeddingMaintenanceNodeType,
  type EmbeddingMaintenanceStatus,
  type WorkerStatusResponse,
} from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import styles from './EmbeddingsMaintenanceView.module.scss';

/** How often the table list is re-read while a table's index is building. */
const TABLES_POLL_MS = 3000;

const labels: Record<EmbeddingMaintenanceNodeType, string> = {
  container: 'Containers',
  doc: 'Documents',
  memory: 'Memories',
  message: 'Messages',
  thread_summary: 'Thread summaries',
  file: 'Files',
  image: 'Images',
  table_entry: 'Table entries',
};
export const EmbeddingsMaintenanceView: FC = () => {
  const [model, setModel] = useState<EmbeddingMaintenanceModel | null>(null);
  const [status, setStatus] = useState<EmbeddingMaintenanceStatus | null>(null);
  const [workers, setWorkers] = useState<WorkerStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const [models, job, policy] = await Promise.all([
        embeddingsApi.listMaintenanceModels(),
        embeddingsApi.getMaintenanceStatus(),
        workersApi.status(),
      ]);
      setModel(models[0] ?? null);
      setStatus(job);
      setWorkers(policy);
      setError(null);
    } catch (e) {
      setError(getErrorMessage(e, 'Could not load search index'));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useGuardedInterval(refresh, { intervalMs: 1500, enabled: true });
  const [tables, setTables] = useState<SemanticTableRow[] | null>(null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const refreshTables = useCallback(async (signal?: { canceled: boolean }) => {
    try {
      const { tables: next } = await tablesApi.semanticOverview();
      if (signal?.canceled) return;
      setTables(next);
      setTablesError(null);
    } catch (e) {
      if (!signal?.canceled) setTablesError(getErrorMessage(e, 'Could not load tables'));
    }
  }, []);
  useEffect(() => {
    void refreshTables();
  }, [refreshTables]);
  useGuardedInterval(refreshTables, {
    intervalMs: TABLES_POLL_MS,
    enabled: tables?.some(isSemanticBuilding) ?? false,
  });
  const updateTable = useCallback((status: SemanticStatus) => {
    setTables((previous) =>
      previous
        ? previous.map((row) => (row.tableId === status.tableId ? withStatus(row, status) : row))
        : previous
    );
  }, []);
  // The build-wide reason, said once; a table held at the cap says its own in its row.
  const tablesPaused = tables?.find(
    (row) => row.enabled && row.paused && !row.awaitingConfirm
  )?.paused;
  const coverage = model?.nodeTypeCoverage ?? [];
  const fresh = coverage.reduce((sum, row) => sum + row.fresh, 0);
  const total = coverage.reduce((sum, row) => sum + row.fresh + row.missing + row.stale, 0);
  const pending = coverage.reduce((sum, row) => sum + row.missing + row.stale, 0);
  const busy = starting || status?.running === true;
  const on =
    workers?.automaticLocalIntelligenceEnabled === true &&
    workers.policy.envEnabled &&
    workers.policy.embeddingsEnabled &&
    workers.policy.active;
  const backfill = async (nodeType?: EmbeddingMaintenanceNodeType) => {
    if (!model || busy) return;
    setStarting(true);
    try {
      setStatus(
        await embeddingsApi.startMaintenanceJob({
          operation: 'backfill',
          modelId: model.id,
          nodeType,
        })
      );
      await refresh();
    } catch (e) {
      setError(getErrorMessage(e, 'Backfill failed'));
    } finally {
      setStarting(false);
    }
  };
  return (
    <section className={styles.view} aria-label="Embeddings">
      <div className={styles.content}>
        <div className={styles.workers}>
          <span>
            Background workers: <strong>{workers ? (on ? 'On' : 'Off') : 'Unknown'}</strong>
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.dispatchEvent(new Event('snaglet:open-worker-controls'))}
          >
            Worker controls
          </Button>
        </div>
        {error && <p role="alert">{error}</p>}
        <div className={styles.heading}>
          <div>
            <h2>Search index</h2>
            <p>
              {fresh.toLocaleString()} of {total.toLocaleString()} indexed
            </p>
          </div>
          <span
            title={
              !pending
                ? 'Everything is indexed and up to date'
                : busy
                  ? 'Backfill is already running'
                  : undefined
            }
          >
            <Button size="sm" disabled={!model || !pending || busy} onClick={() => void backfill()}>
              Backfill all
            </Button>
          </span>
        </div>
        <progress aria-label="Overall indexing progress" max={Math.max(total, 1)} value={fresh} />
        <p className={styles.detail} aria-live="polite">
          {status?.running
            ? `Backfilling ${status.processed} of ${status.total}${status.failed ? ` · ${status.failed} failed` : ''}`
            : pending
              ? `${pending.toLocaleString()} missing or stale. Backfill also works while workers are off.`
              : 'Everything is indexed and up to date.'}
        </p>
        <h3>Coverage by content kind</h3>
        <ul className={styles.coverage}>
          {coverage.map((row) => {
            const remaining = row.missing + row.stale;
            return (
              <li key={row.nodeType}>
                <div>
                  <strong>{labels[row.nodeType]}</strong>
                  <span>
                    {row.fresh} of {row.fresh + remaining} indexed · {row.missing} missing ·{' '}
                    {row.stale} stale
                  </span>
                </div>
                <span
                  title={
                    !remaining
                      ? 'Nothing missing or stale'
                      : busy
                        ? 'Backfill is already running'
                        : undefined
                  }
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || !remaining}
                    onClick={() => void backfill(row.nodeType)}
                  >
                    Backfill {labels[row.nodeType].toLowerCase()}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
        {workers && !model && !error && (
          <p>
            The built-in embedding model is not active in the models catalog. Restart Snaglet to
            restore it.
          </p>
        )}
        <h3>Search by meaning in tables</h3>
        <p className={styles.detail}>{SEMANTIC_DEFAULT_RULE}</p>
        {tablesPaused && <p className={styles.detail}>{tablesPaused}</p>}
        {tablesError && <p role="alert">{tablesError}</p>}
        {tables?.length === 0 && <p className={styles.detail}>No tables yet.</p>}
        {tables && tables.length > 0 && (
          <ul className={`${styles.coverage} ${styles.tables}`} aria-label="Tables">
            {tables.map((row) => (
              <SemanticTableItem key={row.tableId} row={row} onStatus={updateTable} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};

/** A table's overview row with the switch's answer applied. */
function withStatus(row: SemanticTableRow, status: SemanticStatus): SemanticTableRow {
  const next: SemanticTableRow = {
    ...row,
    enabled: status.enabled,
    rows: status.rows,
    rowsCapped: status.rowsCapped,
    needsConfirmation: status.needsConfirmation,
    indexed: status.indexed,
    state: status.state,
    estimate: status.estimate,
  };
  if (status.paused) next.paused = status.paused;
  else delete next.paused;
  if (status.awaitingConfirm) next.awaitingConfirm = true;
  else delete next.awaitingConfirm;
  return next;
}

/** One table: name, project and status line, with its "Search by meaning" switch. */
const SemanticTableItem: FC<{
  row: SemanticTableRow;
  onStatus: (status: SemanticStatus) => void;
}> = ({ row, onStatus }) => {
  const control = useSemanticSwitch(row, onStatus);
  return (
    <li>
      <div>
        <strong>{row.tableName}</strong>
        <span>
          {row.projectName ? `${row.projectName} · ` : ''}
          {semanticStatusLine(row)}
        </span>
        {row.enabled && row.awaitingConfirm && (
          <>
            <span>{row.paused}</span>
            <SemanticConfirm state={row} control={control} held />
          </>
        )}
        {control.confirming && <SemanticConfirm state={row} control={control} />}
        {control.error && <p role="alert">{control.error}</p>}
      </div>
      <Switch
        checked={row.enabled}
        onChange={control.toggle}
        disabled={control.saving}
        onLabel="On"
        offLabel="Off"
        aria-label={`Search by meaning in ${row.tableName}`}
      />
    </li>
  );
};
