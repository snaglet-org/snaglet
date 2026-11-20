import { fetchData, getApiUrl } from './core';
import type { StoredImage } from './types';

export const imagesApi = {
  /**
   * Get image metadata by ID. Fetches from the list endpoint and filters
   * client-side since there's no dedicated GET /images/:id endpoint.
   */
  getMetadata: async (id: string): Promise<StoredImage> => {
    const images = await fetchData<StoredImage[]>(getApiUrl('/images'), { method: 'GET' });
    const found = images.find((img) => img.id === id);
    if (!found) {
      throw new Error('Image not found');
    }
    return found;
  },

  upload: (data: {
    name?: string;
    dataUrl: string;
    /**
     * Placement by thread. The server resolves the thread's current container
     * and places the image there, so the client never asserts a container it
     * may have cached stale. Mutually exclusive with `containerId` — sending
     * both is a 400, not a precedence rule.
     */
    threadId?: string;
    /** Explicit placement, for non-thread callers (workspace/tree uploads). */
    containerId?: string | null;
    description?: string | null;
    tags?: string[];
    /** Positional drop slot — omitted means append at end of the bucket. */
    sortOrder?: number;
  }) =>
    fetchData<StoredImage>(getApiUrl('/images'), {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  /**
   * Move/reorder an image in the workspace tree. `containerId` is the
   * destination container (null = workspace root); `sortOrder` slots it among
   * siblings (omit to append). Mirrors `docsApi.update`'s move shape so the
   * drag dispatcher treats images like every other node kind.
   */
  move: (id: string, containerId: string | null, opts?: { sortOrder?: number }) =>
    fetchData<StoredImage>(getApiUrl(`/images/${id}`), {
      method: 'PATCH',
      body: JSON.stringify({
        containerId,
        ...(opts?.sortOrder !== undefined ? { sortOrder: opts.sortOrder } : {}),
      }),
    }),

  updateMetadata: (id: string, metadata: { description?: string | null; tags?: string[] }) =>
    fetchData<StoredImage>(getApiUrl(`/images/${id}`), {
      method: 'PATCH',
      body: JSON.stringify(metadata),
    }),

  /**
   * Rename an image; the server renames its stored file too. `expectedName`
   * is the name the caller showed: if the image was renamed elsewhere since,
   * the server answers 409 instead of overwriting that rename.
   */
  rename: (id: string, name: string, expectedName?: string) =>
    fetchData<StoredImage>(getApiUrl(`/images/${id}`), {
      method: 'PATCH',
      body: JSON.stringify({ name, ...(expectedName !== undefined ? { expectedName } : {}) }),
    }),
};
