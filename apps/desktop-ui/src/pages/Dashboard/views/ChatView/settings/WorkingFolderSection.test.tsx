import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadWorkingDirectory } from '@desktop/utils/api';
import { WorkingFolderSection } from './WorkingFolderSection';

const api = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('@desktop/utils/api', () => ({
  threadsApi: { getWorkingDirectory: api.get, setWorkingDirectory: api.set },
}));

const THREAD = 'thread-test-a';
const PROJECT = '/projects/test';

function info(extra: Partial<ThreadWorkingDirectory> = {}): ThreadWorkingDirectory {
  return {
    id: THREAD,
    workingDirectory: null,
    effective: PROJECT,
    source: 'project',
    projectFolder: PROJECT,
    inheritedOverride: null,
    overrideProblem: null,
    ...extra,
  };
}

const field = () => screen.getByRole('textbox', { name: 'Thread working folder' });

beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockResolvedValue(info());
  api.set.mockResolvedValue({ id: THREAD, working_directory: null });
});
afterEach(cleanup);

describe('WorkingFolderSection', () => {
  it('shows the project folder as the default agents start in', async () => {
    render(<WorkingFolderSection threadId={THREAD} />);
    expect(await screen.findByTestId('effective-folder')).toHaveTextContent(PROJECT);
    expect(screen.getByText('The project folder (default)')).toBeInTheDocument();
    expect(field()).toBeEnabled();
    expect(field()).toHaveValue('');
  });

  it('with no project folder, agents start in Snaglet home and the field is closed', async () => {
    api.get.mockResolvedValue(
      info({ effective: '/home/test/.snaglet', source: 'home', projectFolder: null })
    );
    render(<WorkingFolderSection threadId={THREAD} />);
    expect(await screen.findByTestId('effective-folder')).toHaveTextContent('/home/test/.snaglet');
    expect(screen.getByText('Snaglet home (default)')).toBeInTheDocument();
    expect(field()).toBeDisabled();
    expect(screen.getByText(/isn’t in a project with a linked folder/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save folder' })).toBeDisabled();
  });

  it('saves the folder typed, then shows what agents will use', async () => {
    const worktree = `${PROJECT}/.snaglet/worktrees/one`;
    api.get
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(
        info({ workingDirectory: worktree, effective: worktree, source: 'thread' })
      );
    render(<WorkingFolderSection threadId={THREAD} />);
    await screen.findByTestId('effective-folder');
    expect(screen.getByRole('button', { name: 'Save folder' })).toBeDisabled();
    fireEvent.change(field(), { target: { value: `  ${worktree}  ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Save folder' }));
    await waitFor(() => expect(api.set).toHaveBeenCalledWith(THREAD, worktree));
    await waitFor(() => expect(screen.getByTestId('effective-folder')).toHaveTextContent(worktree));
    expect(screen.getByText('Set on this thread')).toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('shows the server’s reason when it refuses a folder, and keeps what was typed', async () => {
    api.set.mockRejectedValue(
      new Error('Thread working directory must be inside the project folder')
    );
    render(<WorkingFolderSection threadId={THREAD} />);
    await screen.findByTestId('effective-folder');
    fireEvent.change(field(), { target: { value: '/elsewhere' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('must be inside the project folder');
    expect(field()).toHaveValue('/elsewhere');
    expect(screen.getByTestId('effective-folder')).toHaveTextContent(PROJECT);
  });

  it('“Use the default” clears a saved folder', async () => {
    const worktree = `${PROJECT}/.snaglet/worktrees/one`;
    api.get
      .mockResolvedValueOnce(
        info({ workingDirectory: worktree, effective: worktree, source: 'thread' })
      )
      .mockResolvedValueOnce(info());
    render(<WorkingFolderSection threadId={THREAD} />);
    await waitFor(() => expect(field()).toHaveValue(worktree));
    fireEvent.click(screen.getByRole('button', { name: 'Use the default' }));
    await waitFor(() => expect(api.set).toHaveBeenCalledWith(THREAD, null));
    await waitFor(() => expect(field()).toHaveValue(''));
    expect(screen.getByText('The project folder (default)')).toBeInTheDocument();
  });

  it('warns when a saved folder can’t be used and says what agents use instead', async () => {
    const gone = `${PROJECT}/.snaglet/worktrees/gone`;
    api.get.mockResolvedValue(
      info({
        workingDirectory: gone,
        overrideProblem: `Thread working directory does not exist: ${gone}.`,
      })
    );
    render(<WorkingFolderSection threadId={THREAD} />);
    expect(await screen.findByRole('status')).toHaveTextContent('The saved folder can’t be used');
    expect(screen.getByRole('status')).toHaveTextContent('does not exist');
    expect(screen.getByTestId('effective-folder')).toHaveTextContent(PROJECT);
  });

  it('says so when the folder comes from a parent thread', async () => {
    const parent = `${PROJECT}/.snaglet/worktrees/parent`;
    api.get.mockResolvedValue(
      info({ effective: parent, source: 'thread', inheritedOverride: parent })
    );
    render(<WorkingFolderSection threadId={THREAD} />);
    expect(await screen.findByText(/inherited from the parent thread/)).toBeInTheDocument();
  });

  it('shows a failed load', async () => {
    api.get.mockRejectedValue(new Error('Network down'));
    render(<WorkingFolderSection threadId={THREAD} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
  });
});
