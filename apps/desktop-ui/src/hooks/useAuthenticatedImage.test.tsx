import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuthenticatedImage } from './useAuthenticatedImage';

describe('useAuthenticatedImage', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let createdBlobUrls: string[] = [];
  let revokedBlobUrls: string[] = [];

  beforeEach(() => {
    // Mock global fetch
    mockFetch = vi.fn();
    global.fetch = mockFetch;

    // Mock URL.createObjectURL and URL.revokeObjectURL
    createdBlobUrls = [];
    revokedBlobUrls = [];

    global.URL.createObjectURL = vi.fn(() => {
      const url = `blob:mock-${createdBlobUrls.length}`;
      createdBlobUrls.push(url);
      return url;
    });

    global.URL.revokeObjectURL = vi.fn((url) => {
      revokedBlobUrls.push(url);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null blobUrl and no loading when imageId is null', () => {
    const { result } = renderHook(() => useAuthenticatedImage(null));

    expect(result.current.blobUrl).toBe(null);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(null);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null blobUrl and no loading when imageId is undefined', () => {
    const { result } = renderHook(() => useAuthenticatedImage(undefined));

    expect(result.current.blobUrl).toBe(null);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(null);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches image content and returns blob URL', async () => {
    const mockBlob = new Blob(['mock image data'], { type: 'image/png' });
    mockFetch.mockResolvedValue({
      ok: true,
      blob: async () => mockBlob,
    });

    const { result } = renderHook(() => useAuthenticatedImage('image-123'));

    // Initially loading
    expect(result.current.loading).toBe(true);
    expect(result.current.blobUrl).toBe(null);
    expect(result.current.error).toBe(null);

    // Verify fetch was called with correct URL
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/images/image-123/content'),
      expect.objectContaining({
        method: 'GET',
      })
    );

    // Wait for the fetch to complete
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Verify blob URL was created
    expect(result.current.blobUrl).toBe('blob:mock-0');
    expect(result.current.error).toBe(null);
    expect(createdBlobUrls).toEqual(['blob:mock-0']);
    expect(URL.createObjectURL).toHaveBeenCalledWith(mockBlob);
  });

  it('sets error state when fetch fails with 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const { result } = renderHook(() => useAuthenticatedImage('image-123'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.blobUrl).toBe(null);
    expect(result.current.error?.message).toContain('401');
  });

  it('sets error state when fetch fails with 404', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const { result } = renderHook(() => useAuthenticatedImage('image-123'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.blobUrl).toBe(null);
    expect(result.current.error?.message).toContain('404');
  });

  it('sets error state when fetch fails with network error', async () => {
    const mockError = new Error('Network error');
    mockFetch.mockRejectedValue(mockError);

    const { result } = renderHook(() => useAuthenticatedImage('image-123'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.blobUrl).toBe(null);
    expect(result.current.error).toEqual(mockError);
  });

  it('revokes blob URL when imageId changes', async () => {
    const mockBlob1 = new Blob(['image 1'], { type: 'image/png' });
    const mockBlob2 = new Blob(['image 2'], { type: 'image/png' });

    mockFetch
      .mockResolvedValueOnce({ ok: true, blob: async () => mockBlob1 })
      .mockResolvedValueOnce({ ok: true, blob: async () => mockBlob2 });

    const { result, rerender } = renderHook(({ imageId }) => useAuthenticatedImage(imageId), {
      initialProps: { imageId: 'image-123' },
    });

    // Wait for first image to load
    await waitFor(() => {
      expect(result.current.blobUrl).toBe('blob:mock-0');
    });

    // Change imageId
    rerender({ imageId: 'image-456' });

    // Wait for second image to load
    await waitFor(() => {
      expect(result.current.blobUrl).toBe('blob:mock-1');
    });

    // Verify first blob URL was revoked
    expect(revokedBlobUrls).toContain('blob:mock-0');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-0');
  });

  it('revokes blob URL when imageId changes to null', async () => {
    const mockBlob = new Blob(['image data'], { type: 'image/png' });
    mockFetch.mockResolvedValue({ ok: true, blob: async () => mockBlob });

    const { result, rerender } = renderHook(({ imageId }) => useAuthenticatedImage(imageId), {
      initialProps: { imageId: 'image-123' as string | null },
    });

    // Wait for image to load
    await waitFor(() => {
      expect(result.current.blobUrl).toBe('blob:mock-0');
    });

    // Change imageId to null
    rerender({ imageId: null });

    // Verify blob URL was revoked and state reset
    expect(result.current.blobUrl).toBe(null);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(null);
    expect(revokedBlobUrls).toContain('blob:mock-0');
  });

  it('revokes blob URL on unmount', async () => {
    const mockBlob = new Blob(['image data'], { type: 'image/png' });
    mockFetch.mockResolvedValue({ ok: true, blob: async () => mockBlob });

    const { result, unmount } = renderHook(() => useAuthenticatedImage('image-123'));

    // Wait for image to load
    await waitFor(() => {
      expect(result.current.blobUrl).toBe('blob:mock-0');
    });

    // Unmount the hook
    unmount();

    // Verify blob URL was revoked
    expect(revokedBlobUrls).toContain('blob:mock-0');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-0');
  });

  it('handles stale responses (imageId changes before fetch completes)', async () => {
    const mockBlob1 = new Blob(['image 1'], { type: 'image/png' });
    const mockBlob2 = new Blob(['image 2'], { type: 'image/png' });

    let resolve1: (value: { ok: boolean; blob: () => Promise<Blob> }) => void;
    let resolve2: (value: { ok: boolean; blob: () => Promise<Blob> }) => void;

    const promise1 = new Promise<{ ok: boolean; blob: () => Promise<Blob> }>((resolve) => {
      resolve1 = resolve;
    });
    const promise2 = new Promise<{ ok: boolean; blob: () => Promise<Blob> }>((resolve) => {
      resolve2 = resolve;
    });

    mockFetch.mockReturnValueOnce(promise1).mockReturnValueOnce(promise2);

    const { result, rerender } = renderHook(({ imageId }) => useAuthenticatedImage(imageId), {
      initialProps: { imageId: 'image-123' },
    });

    // Change imageId before first fetch completes
    rerender({ imageId: 'image-456' });

    // Complete second fetch first
    resolve2!({ ok: true, blob: async () => mockBlob2 });
    await waitFor(() => {
      expect(result.current.blobUrl).toBe('blob:mock-0');
    });

    // Complete first fetch (stale)
    resolve1!({ ok: true, blob: async () => mockBlob1 });

    // Give time for stale response to be processed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify only the surviving (second) blob URL is active. The stale run is
    // aborted on the imageId change, so its late response never reaches the
    // commit path and NO blob URL is created for it — only one is ever made.
    expect(result.current.blobUrl).toBe('blob:mock-0');
    expect(createdBlobUrls.length).toBe(1); // Stale run aborted → no wasted blob
  });

  it('handles non-Error exceptions gracefully', async () => {
    mockFetch.mockRejectedValue('string error');

    const { result } = renderHook(() => useAuthenticatedImage('image-123'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.blobUrl).toBe(null);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('Failed to load image');
  });
});
