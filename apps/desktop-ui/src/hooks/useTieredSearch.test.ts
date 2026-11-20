/**
 * useTieredSearch — the keyword-first / debounced-hybrid orchestration shared
 * by the palette, @-mention popup and tree search. Pins the contract:
 * keyword fires every keystroke, hybrid only fires debounced and only
 * for queries >= the min length, a new keystroke aborts the in-flight request,
 * and stale responses are dropped.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/utils/api/palette-search.js', () => ({
  paletteSearchApi: { search: vi.fn() },
}));

import { paletteSearchApi, type PaletteAugmentedResponse } from '@desktop/utils/api/palette-search';
import { mergePaletteHits, stableMergeById, useTieredSearch } from './useTieredSearch';

const searchMock = vi.mocked(paletteSearchApi.search);

function response(overrides: Partial<PaletteAugmentedResponse> = {}): PaletteAugmentedResponse {
  return {
    byKind: {},
    channelsUsed: [],
    semanticStatus: 'ready',
    coverage: {},
    items: [],
    filesystem: [],
    files: [],
    meta: { query: '', kinds: [], workspaceCount: 0, filesystemCount: 0 },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = () => act(async () => {});
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  searchMock.mockReset();
  searchMock.mockResolvedValue(response());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('stableMergeById', () => {
  it('keeps instant items in place and appends only enriched-only items', () => {
    const instant = [{ id: 'a' }, { id: 'b' }];
    const enriched = [{ id: 'b' }, { id: 'c' }, { id: 'a' }, { id: 'd' }];
    const merged = stableMergeById(instant, enriched, (x) => x.id);
    expect(merged.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is a no-op append when enriched is empty', () => {
    const instant = [{ id: 'a' }];
    expect(stableMergeById(instant, [], (x) => x.id)).toEqual(instant);
  });
});

describe('mergePaletteHits', () => {
  it('keeps keyword position while overlaying hybrid channel metadata', () => {
    const instant = [
      { node_id: 'a', kind: 'doc' as const, score: 0.1, channels: ['fts' as const], payload: {} },
    ];
    const enriched = [
      {
        node_id: 'a',
        kind: 'doc' as const,
        score: 0.2,
        channels: ['fts' as const, 'vector' as const],
        payload: {},
      },
    ];

    expect(mergePaletteHits(instant, enriched)[0]).toMatchObject({
      node_id: 'a',
      channels: ['fts', 'vector'],
    });
  });

  it('holds keyword order and appends hybrid-only results once', () => {
    const instant = [
      {
        node_id: 'a',
        kind: 'doc' as const,
        score: 0.2,
        channels: ['fts' as const],
        payload: {},
      },
      { node_id: 'b', kind: 'doc' as const, score: 0.1, channels: ['fts' as const], payload: {} },
    ];
    const enriched = [
      { ...instant[1], channels: ['fts' as const, 'vector' as const] },
      {
        node_id: 'c',
        kind: 'doc' as const,
        score: 0.3,
        channels: ['vector' as const],
        payload: {},
      },
      { ...instant[0], channels: ['fts' as const, 'vector' as const] },
    ];

    expect(mergePaletteHits(instant, enriched).map((hit) => hit.node_id)).toEqual(['a', 'b', 'c']);
  });
});

describe('useTieredSearch tiering', () => {
  it('fires the keyword tier immediately and no hybrid tier below the min length', async () => {
    renderHook(() => useTieredSearch({ query: 'ab' }));
    await flush();

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][0]).toMatchObject({ query: 'ab', mode: 'keyword' });

    // Well past the debounce — still no hybrid tier (query is under 3 chars).
    await advance(1000);
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it('fires the hybrid tier only after the debounce for queries >= the min length', async () => {
    renderHook(() => useTieredSearch({ query: 'abc', debounceMs: 300 }));
    await flush();

    // Instant keyword only, so far.
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][0]).toMatchObject({ mode: 'keyword' });

    await advance(299);
    expect(searchMock).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(searchMock.mock.calls[1][0]).toMatchObject({ query: 'abc', mode: 'hybrid' });
  });

  it('never schedules a third settled rerank request', async () => {
    renderHook(() => useTieredSearch({ query: 'two-tiers' }));
    await flush();
    await advance(1000);

    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(searchMock.mock.calls.map(([request]) => request.mode)).toEqual(['keyword', 'hybrid']);
    expect(searchMock.mock.calls.every(([request]) => !('settled' in request))).toBe(true);
  });

  it('runs semantic-only when the user disables keyword search', async () => {
    renderHook(() =>
      useTieredSearch({
        query: 'meaning',
        channels: { keyword: false, vector: true },
        debounceMs: 300,
      })
    );
    await flush();

    expect(searchMock).not.toHaveBeenCalled();
    await advance(300);

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][0]).toMatchObject({ query: 'meaning', mode: 'semantic' });
  });

  it('runs keyword-only when the user disables vector search', async () => {
    renderHook(() =>
      useTieredSearch({ query: 'literal', channels: { keyword: true, vector: false } })
    );
    await flush();
    await advance(1000);

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][0]).toMatchObject({ query: 'literal', mode: 'keyword' });
  });

  it('does not fire when disabled and clears results', async () => {
    const { result } = renderHook(() => useTieredSearch({ query: 'abc', enabled: false }));
    await advance(1000);
    expect(searchMock).not.toHaveBeenCalled();
    expect(result.current.instant).toBeNull();
    expect(result.current.enriched).toBeNull();
  });

  it('aborts the in-flight keyword request when the query changes', async () => {
    searchMock.mockImplementation(() => new Promise<PaletteAugmentedResponse>(() => {}));
    const { rerender } = renderHook(({ query }) => useTieredSearch({ query }), {
      initialProps: { query: 'abc' },
    });
    await flush();

    const firstSignal = searchMock.mock.calls[0][0].signal;
    expect(firstSignal?.aborted).toBe(false);

    rerender({ query: 'abcd' });
    await flush();

    expect(firstSignal?.aborted).toBe(true);
    // A fresh keyword request went out for the new query.
    const lastCall = searchMock.mock.calls[searchMock.mock.calls.length - 1];
    expect(lastCall[0]).toMatchObject({ query: 'abcd', mode: 'keyword' });
  });

  it('drops a stale keyword response that resolves after a newer query', async () => {
    const first = deferred<PaletteAugmentedResponse>();
    const second = deferred<PaletteAugmentedResponse>();
    searchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(({ query }) => useTieredSearch({ query }), {
      initialProps: { query: 'aa' },
    });
    await flush();
    rerender({ query: 'bb' });
    await flush();

    // The newer request resolves first, then the stale one — the stale value
    // must never overwrite the current results.
    second.resolve(response({ semanticStatus: 'disabled' }));
    await flush();
    first.resolve(response({ semanticStatus: 'unavailable' }));
    await flush();

    expect(result.current.instant?.semanticStatus).toBe('disabled');
  });
});
