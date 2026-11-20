/**
 * useTreeFileImport: an image dropped on the workspace tree uploads up to the
 * shared 50 MB limit. A larger one is refused with a toast that names the
 * limit, and nothing is sent for it.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ upload: vi.fn(), importFile: vi.fn(), showToast: vi.fn() }));

vi.mock('../../../utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/api')>();
  return {
    ...actual,
    imagesApi: { ...actual.imagesApi, upload: mocks.upload },
    docsApi: { ...actual.docsApi, importFile: mocks.importFile },
  };
});
vi.mock('@desktop/utils/toast', () => ({ showToast: mocks.showToast }));

import { useTreeFileImport } from './useTreeFileImport';

const MB = 1024 * 1024;

/** A PNG `File` that reports `size` bytes without holding them. */
function imageFile(name: string, size: number): File {
  const file = new File(['image bytes'], name, { type: 'image/png' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function dropOnRoot(files: File[]) {
  const { result } = renderHook(() =>
    useTreeFileImport({ setHoverTargetId: vi.fn(), setHoverZone: vi.fn() })
  );
  act(() => result.current.handleFileDrop(null, 'inside', files as unknown as FileList));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.upload.mockResolvedValue({ id: 'image-1111111111111-aaaaaaaaa' });
});

describe('useTreeFileImport image size', () => {
  it('uploads a 9 MB image', async () => {
    dropOnRoot([imageFile('large.png', 9 * MB)]);

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    expect(mocks.upload.mock.calls[0]?.[0]).toMatchObject({ name: 'large.png', containerId: null });
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('refuses an image over 50 MB with the limit and sends nothing for it', async () => {
    dropOnRoot([imageFile('huge.png', 72 * MB), imageFile('small.png', MB)]);

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    expect(mocks.upload.mock.calls[0]?.[0]).toMatchObject({ name: 'small.png' });
    expect(mocks.showToast).toHaveBeenCalledWith('"huge.png" is 72 MB. Images can be up to 50 MB.');
  });
});
