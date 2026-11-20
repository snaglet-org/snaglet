/**
 * The notice for a save refused because it would loop shows once per loop,
 * not on every autosave that keeps the loop, and afresh after a good save.
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const toast = vi.hoisted(() => vi.fn());
vi.mock('@desktop/utils/toast', () => ({ showToast: toast }));

import { useSaveLoopNotice } from './transclusions';

const refusal = (ids: string[]) => ({
  details: { transclusionLoop: ids.map((id) => ({ id, title: id.toUpperCase() })) },
});

describe('useSaveLoopNotice', () => {
  beforeEach(() => toast.mockClear());

  it('shows each loop once until a save goes through', () => {
    const { result } = renderHook(() => useSaveLoopNotice());
    result.current.refused(refusal(['doc-a', 'doc-b', 'doc-a']));
    result.current.refused(refusal(['doc-a', 'doc-b', 'doc-a']));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]![0]).toContain('(DOC-A → DOC-B → DOC-A)');

    result.current.refused(refusal(['doc-a', 'doc-c', 'doc-a']));
    expect(toast).toHaveBeenCalledTimes(2);

    result.current.saved();
    result.current.refused(refusal(['doc-a', 'doc-c', 'doc-a']));
    expect(toast).toHaveBeenCalledTimes(3);
  });

  it('ignores other save errors', () => {
    const { result } = renderHook(() => useSaveLoopNotice());
    result.current.refused(new Error('offline'));
    expect(toast).not.toHaveBeenCalled();
  });
});
