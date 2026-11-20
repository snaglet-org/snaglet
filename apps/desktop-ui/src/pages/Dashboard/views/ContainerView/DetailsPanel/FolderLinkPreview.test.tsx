import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectsApi } from '@desktop/utils/api/projects';
import { FolderLinkPreview } from './FolderLinkPreview';

vi.mock('@desktop/utils/api/projects', () => ({
  projectsApi: { previewFolderPath: vi.fn(), saveFolderPath: vi.fn() },
}));
const preview = vi.mocked(projectsApi.previewFolderPath);
const save = vi.mocked(projectsApi.saveFolderPath);
const onSaved = vi.fn();
const onCancel = vi.fn();
const impact = {
  folderPath: '/tmp/projects',
  eligibleFiles: 3000,
  scannedEntries: 3200,
  capped: false,
  warnings: ['This looks like a folder of repositories.'],
  childRepositories: ['one', 'two'],
  replacingFolder: true,
  requiresConfirmation: true,
};
function show(candidate = '/tmp/projects') {
  render(
    <FolderLinkPreview
      projectId="project-test"
      candidate={candidate}
      previousFolder="/tmp/old"
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  preview.mockResolvedValue(impact);
  save.mockResolvedValue({ id: 'project-test', folderPath: impact.folderPath } as Awaited<
    ReturnType<typeof projectsApi.saveFolderPath>
  >);
});
describe('FolderLinkPreview', () => {
  it('inspects before saving and cancel makes no mutation', async () => {
    show();
    expect(await screen.findByText(/3,000 eligible files/)).toBeInTheDocument();
    expect(screen.getByText(/folder of repositories/)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('only saves after explicit confirmation and passes optional cache cleanup', async () => {
    show();
    await screen.findByText(/3,000 eligible files/);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Link this folder' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('project-test', '/tmp/projects', {
        confirmFolderLink: true,
        clearPreviousIndex: true,
      })
    );
    expect(onSaved).toHaveBeenCalled();
  });
  it('failed preview cannot persist a folder', async () => {
    preview.mockRejectedValue(new Error('Folder not found'));
    show();
    await screen.findByText('Folder not found');
    fireEvent.click(screen.getByRole('button', { name: 'Link this folder' }));
    await waitFor(() => expect(screen.getAllByText('Folder not found').length).toBeGreaterThan(0));
    expect(save).not.toHaveBeenCalled();
  });
  it('unlink explains cache removal and requires confirmation', async () => {
    show('');
    expect(preview).not.toHaveBeenCalled();
    expect(screen.getByText(/source files remain unchanged/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unlink folder' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('project-test', null, {
        confirmFolderLink: true,
        clearPreviousIndex: false,
      })
    );
  });
});
