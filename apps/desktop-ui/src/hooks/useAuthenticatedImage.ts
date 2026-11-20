import { useEffect, useState } from 'react';
import { getApiUrl } from '../utils/api';

/**
 * Load an image from Snaglet's authenticated endpoint as a temporary blob URL, with
 * loading/error state and cleanup. The global wrapped fetch() attaches the
 * session headers. Each effect run owns its `cancelled` flag, AbortController
 * and blob URL, so StrictMode's double invoke is safe and a run only revokes
 * its own URL. Aborts are silent.
 *
 * @param imageId - The Snaglet image node ID to load
 * @returns { blobUrl, loading, error }
 */
export function useAuthenticatedImage(imageId: string | null | undefined) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // No image → clear everything and do nothing.
    if (!imageId) {
      setBlobUrl(null);
      setLoading(false);
      setError(null);
      return;
    }

    let canceled = false;
    let createdUrl: string | null = null;
    const controller = new AbortController();

    // Reset visible state for the new id.
    setBlobUrl(null);
    setError(null);
    setLoading(true);

    (async () => {
      try {
        // getApiUrl() already prepends the API base (`/api` in dev,
        // `origin/api` in prod). Pass the path without a leading `/api` or the
        // base is doubled (`/api/api/images/...` → 404).
        const res = await fetch(getApiUrl(`/images/${imageId}/content`), {
          method: 'GET',
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`Failed to load image: ${res.status} ${res.statusText}`);
        }

        const blob = await res.blob();

        // If this run was superseded/unmounted while awaiting, do not commit.
        if (canceled) return;

        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
        setLoading(false);
      } catch (err) {
        // Aborted runs are silent — the newer run owns the state.
        if (canceled || (err instanceof Error && err.name === 'AbortError')) {
          return;
        }
        setError(err instanceof Error ? err : new Error('Failed to load image'));
        setLoading(false);
      }
    })();

    return () => {
      canceled = true;
      controller.abort();
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
        createdUrl = null;
      }
    };
  }, [imageId]);

  return { blobUrl, loading, error };
}
