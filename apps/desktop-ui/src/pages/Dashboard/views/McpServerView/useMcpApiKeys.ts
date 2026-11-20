import { useCallback, useEffect, useState } from 'react';
import { mcpApiKeysApi } from '@desktop/utils/api';
import type { McpApiKey, McpApiKeyMint } from '@desktop/utils/api';
import { getErrorMessage } from '@snaglet/shared/utils';

interface MintedMcpToken {
  keyId: string;
  token: string;
}

export interface UseMcpApiKeys {
  keys: McpApiKey[];
  loading: boolean;
  error: string | null;
  busyId: string | null;
  /** Plaintext token from the last mint, held only in memory and cleared on dismiss/reload. */
  mintedToken: MintedMcpToken | null;
  setError: (e: string | null) => void;
  dismissToken: () => void;
  /** Stale-while-revalidate refetch — consumers call it on mount so a visit
   *  shows keys minted/revoked out-of-band since the provider first loaded. */
  reload: () => Promise<void>;
  mint: (name: string) => Promise<McpApiKeyMint | null>;
  rename: (id: string, name: string) => Promise<boolean>;
  revoke: (id: string) => Promise<void>;
}

/** Data + mutations for external MCP client connections. */
export function useMcpApiKeys(): UseMcpApiKeys {
  const [keys, setKeys] = useState<McpApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mintedToken, setMintedToken] = useState<MintedMcpToken | null>(null);

  const reload = useCallback(async () => {
    try {
      setKeys(await mcpApiKeysApi.list());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const mint = useCallback(
    async (name: string) => {
      setBusyId('mint');
      try {
        const result = await mcpApiKeysApi.mint(name);
        setMintedToken({ keyId: result.key.id, token: result.token });
        await reload();
        return result;
      } catch (err) {
        setError(getErrorMessage(err));
        return null;
      } finally {
        setBusyId(null);
      }
    },
    [reload]
  );

  const rename = useCallback(async (id: string, name: string) => {
    setBusyId(id);
    try {
      const updated = await mcpApiKeysApi.rename(id, name);
      setKeys((previous) => previous.map((key) => (key.id === id ? updated : key)));
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setBusyId(null);
    }
  }, []);

  const revoke = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await mcpApiKeysApi.revoke(id);
      // Revocation deletes the row — drop it from the list, don't keep it.
      setKeys((prev) => prev.filter((k) => k.id !== id));
      setMintedToken((current) => (current?.keyId === id ? null : current));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }, []);

  return {
    keys,
    loading,
    error,
    busyId,
    mintedToken,
    setError,
    dismissToken: () => setMintedToken(null),
    reload,
    mint,
    rename,
    revoke,
  };
}
