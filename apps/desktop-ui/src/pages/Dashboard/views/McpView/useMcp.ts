import { useCallback, useEffect, useState } from 'react';
import { mcpServersApi } from '@desktop/utils/api';
import type {
  McpServer,
  McpServerUpsert,
  McpTestResult,
  McpCredentialInput,
  McpInstallResult,
} from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';
import { emitMcpConnectionEvent } from '@desktop/utils/mcpConnectionEvents';

export interface UseMcp {
  servers: McpServer[];
  loading: boolean;
  error: string | null;
  busyId: string | null;
  testResults: Record<string, McpTestResult | undefined>;
  testingId: string | null;
  /** The server whose package Update is installing, if any. */
  updatingId: string | null;
  setError: (e: string | null) => void;
  reload: () => Promise<void>;
  createServer: (data: McpServerUpsert) => Promise<boolean>;
  updateServer: (id: string, data: McpServerUpsert) => Promise<boolean>;
  /** Resolves true when the server was deleted; a failure lands in `error`. */
  removeServer: (id: string) => Promise<boolean>;
  /** Undo a recent delete. Rejects on failure so the caller can say so where the user is looking. */
  restoreServer: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  testServer: (id: string) => Promise<void>;
  /**
   * Update an npx server's installed package (and restart it if running).
   * Resolves with what happened; rejects when the request itself fails, so
   * the caller can say so where the user is looking.
   */
  updatePackage: (id: string) => Promise<McpInstallResult>;
  saveCredential: (id: string, body: McpCredentialInput) => Promise<boolean>;
  deleteCredential: (id: string) => Promise<void>;
}

/** Data + mutations for upstream MCP server connections. Hand-rolled state,
 *  matching the app's per-view hook convention (no react-query). Every mutation
 *  refreshes the affected server from the API response so live decorations stay fresh. */
export function useMcp(): UseMcp {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, McpTestResult | undefined>>({});

  const reload = useCallback(async () => {
    try {
      const list = await mcpServersApi.list();
      setServers(list);
      // A successful load supersedes an earlier failure's banner.
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const replace = useCallback((updated: McpServer) => {
    setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  }, []);

  // Every successful mutation announces "the server set changed" on the
  // client-side MCP event bus. This hook's single Dashboard-mounted instance
  // owns all UI mutations, but other surfaces (AgentView's MCP section, the
  // tool-access option list) fetch their own copies and stay mounted while
  // the sidebar edits happen — without this signal they'd only refresh on a
  // remount that re-selecting the same pane never triggers.
  const announceServersChanged = useCallback(() => {
    emitMcpConnectionEvent({ type: 'servers-changed' });
  }, []);

  const createServer = useCallback(
    async (data: McpServerUpsert) => {
      setBusyId(data.id);
      try {
        await mcpServersApi.create(data);
        await reload();
        announceServersChanged();
        return true;
      } catch (err) {
        setError(getErrorMessage(err));
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [reload, announceServersChanged]
  );

  const updateServer = useCallback(
    async (id: string, data: McpServerUpsert) => {
      setBusyId(id);
      try {
        const updated = await mcpServersApi.update(id, data);
        replace(updated);
        announceServersChanged();
        return true;
      } catch (err) {
        setError(getErrorMessage(err));
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [replace, announceServersChanged]
  );

  const removeServer = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await mcpServersApi.remove(id);
        setServers((prev) => prev.filter((s) => s.id !== id));
        announceServersChanged();
        return true;
      } catch (err) {
        setError(getErrorMessage(err));
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [announceServersChanged]
  );

  const restoreServer = useCallback(
    async (id: string) => {
      await mcpServersApi.restore(id);
      await reload();
      announceServersChanged();
    },
    [reload, announceServersChanged]
  );

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      setBusyId(id);
      try {
        const updated = await mcpServersApi.setEnabled(id, enabled);
        replace(updated);
        announceServersChanged();
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setBusyId(null);
      }
    },
    [replace, announceServersChanged]
  );

  const testServer = useCallback(async (id: string) => {
    setTestingId(id);
    try {
      const result = await mcpServersApi.test(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, status: 'error', toolCount: 0, error: getErrorMessage(err) },
      }));
    } finally {
      setTestingId(null);
    }
  }, []);

  const updatePackage = useCallback(
    async (id: string) => {
      setUpdatingId(id);
      try {
        const result = await mcpServersApi.install(id);
        replace(result.server);
        announceServersChanged();
        return result;
      } finally {
        setUpdatingId(null);
      }
    },
    [replace, announceServersChanged]
  );

  const saveCredential = useCallback(
    async (id: string, body: McpCredentialInput) => {
      setBusyId(id);
      try {
        const updated = await mcpServersApi.saveCredential(id, body);
        replace(updated);
        announceServersChanged();
        return true;
      } catch (err) {
        setError(getErrorMessage(err));
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [replace, announceServersChanged]
  );

  const deleteCredential = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const updated = await mcpServersApi.deleteCredential(id);
        replace(updated);
        announceServersChanged();
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setBusyId(null);
      }
    },
    [replace, announceServersChanged]
  );

  return {
    servers,
    loading,
    error,
    busyId,
    testResults,
    testingId,
    updatingId,
    setError,
    reload,
    createServer,
    updateServer,
    removeServer,
    restoreServer,
    setEnabled,
    testServer,
    updatePackage,
    saveCredential,
    deleteCredential,
  };
}
