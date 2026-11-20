import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectsApi } from '@desktop/utils/api';
import type { IndexConfig } from '@desktop/utils/api/projects';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { IndexingRulesPanel } from './IndexingRulesPanel';

vi.mock('@desktop/utils/api', () => ({
  projectsApi: {
    getIndexConfig: vi.fn(),
    getFileIndexingImpact: vi.fn(),
    updateIndexConfig: vi.fn(),
  },
}));

vi.mock('@desktop/components', () => ({
  Button: ({ children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) => (
    <button {...props}>{children}</button>
  ),
}));

const getIndexConfig = vi.mocked(projectsApi.getIndexConfig);
const getFileIndexingImpact = vi.mocked(projectsApi.getFileIndexingImpact);
const updateIndexConfig = vi.mocked(projectsApi.updateIndexConfig);

const config: IndexConfig = {
  hasFolder: true,
  folderPath: '/tmp/project',
  configExists: true,
  parseError: false,
  enabled: true,
  includePaths: [],
  ignorePaths: [],
  ignoreFileTypes: [],
  defaults: { dirs: ['node_modules'], filenames: [], extensions: ['png'] },
};

beforeEach(() => {
  getIndexConfig.mockReset().mockResolvedValue(config);
  getFileIndexingImpact
    .mockReset()
    .mockResolvedValue({ eligibleFiles: 42, scannedEntries: 60, capped: false });
  updateIndexConfig.mockReset().mockImplementation(async (_projectId, edits) => ({
    ...config,
    includePaths: edits.includePaths ?? [],
    ignorePaths: edits.ignorePaths ?? [],
    ignoreFileTypes: edits.ignoreFileTypes ?? [],
  }));
});

afterEach(() => vi.useRealTimers());

describe('IndexingRulesPanel', () => {
  it('adds rules immediately and saves a rapid burst in one request', async () => {
    render(<IndexingRulesPanel projectId="project-1" />);
    const input = await screen.findByRole('textbox', { name: 'Add ignore paths' });
    const includeInput = screen.getByRole('textbox', { name: 'Add only include paths' });
    vi.useFakeTimers();

    fireEvent.change(includeInput, { target: { value: 'src' } });
    fireEvent.keyDown(includeInput, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'dist' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'coverage' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByText('dist')).toBeInTheDocument();
    expect(screen.getByText('coverage')).toBeInTheDocument();
    expect(input).not.toBeDisabled();
    expect(updateIndexConfig).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect(updateIndexConfig).toHaveBeenCalledTimes(1);
    expect(updateIndexConfig).toHaveBeenCalledWith('project-1', {
      includePaths: ['src'],
      ignorePaths: ['dist', 'coverage'],
      ignoreFileTypes: [],
    });
  });

  it('updates the impact estimate from the completed reconciliation event', async () => {
    render(<IndexingRulesPanel projectId="project-1" />);
    expect(await screen.findByText('42 eligible files')).toBeInTheDocument();

    act(() =>
      emitLibraryEvent({
        type: 'file-indexing-impact-changed',
        projectId: 'project-1',
        eligibleFiles: 7,
        scannedEntries: 18,
        capped: false,
      })
    );

    expect(screen.getByText('7 eligible files')).toBeInTheDocument();
    expect(screen.getByText('18 entries scanned')).toBeInTheDocument();
  });
});
