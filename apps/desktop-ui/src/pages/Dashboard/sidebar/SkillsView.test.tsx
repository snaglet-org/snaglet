import { checkSidebarDisclosures } from '@desktop/test/sidebarDisclosure';
/**
 * SkillsView — read-only Skills sidebar: flat list sorted by
 * the server, ⚠ + error for invalid skills, no "missing" state (a removed
 * folder's skill just drops off the list),
 * expanding a row lists files, clicking a file opens the viewer, Reveal calls
 * the API, and the list refreshes on a timer.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillInfo } from '@desktop/utils/api/skills';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const { listMock, filesMock, revealMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  filesMock: vi.fn(),
  revealMock: vi.fn(),
}));
vi.mock('@desktop/utils/api/skills', () => ({
  skillsApi: { list: listMock, files: filesMock, reveal: revealMock, file: vi.fn() },
}));

import { SkillsView, SKILLS_REFRESH_MS } from './SkillsView';

function skill(slug: string, over: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id: `skill-${slug}`,
    slug,
    name: slug,
    description: `${slug} does things`,
    status: 'valid',
    error: null,
    sourcePath: `/home/u/.snaglet/skills/${slug}/SKILL.md`,
    folderPath: `/home/u/.snaglet/skills/${slug}`,
    version: 'abcd1234',
    indexedAt: '',
    ...over,
  };
}

const LIST = [
  skill('alpha'),
  skill('broken', { status: 'invalid', error: 'missing description', version: null }),
];

beforeEach(() => {
  listMock.mockReset().mockResolvedValue(LIST);
  filesMock.mockReset().mockResolvedValue({
    files: [
      { path: 'SKILL.md', size: 10 },
      { path: 'templates/pr.md', size: 4 },
    ],
    truncated: false,
  });
  revealMock.mockReset().mockResolvedValue({ revealed: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SkillsView', () => {
  it('lists present skills with descriptions and marks invalid ones', async () => {
    render(<SkillsView onFileOpen={vi.fn()} activeSkillId={null} />);
    expect(await screen.findByText('alpha')).toBeTruthy();
    expect(screen.getByText('alpha does things')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Invalid skill' })).toBeTruthy();
    expect(screen.getByText('missing description')).toBeTruthy();
  });

  it('expands a skill to its files and opens one in the viewer', async () => {
    const onFileOpen = vi.fn();
    render(<SkillsView onFileOpen={onFileOpen} activeSkillId={null} />);
    fireEvent.click(await screen.findByTestId('skill-row-alpha'));
    expect(filesMock).toHaveBeenCalledWith('skill-alpha');
    fireEvent.click(await screen.findByText('templates/pr.md'));
    expect(onFileOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'skill-alpha', slug: 'alpha' }),
      'templates/pr.md'
    );
  });

  it('Reveal in Finder calls the API without expanding the row', async () => {
    render(<SkillsView onFileOpen={vi.fn()} activeSkillId={null} />);
    await screen.findByText('alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Reveal alpha in Finder' }));
    expect(revealMock).toHaveBeenCalledWith('skill-alpha');
    expect(filesMock).not.toHaveBeenCalled();
  });

  it('refreshes the list on a timer (live refresh)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<SkillsView onFileOpen={vi.fn()} activeSkillId={null} />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    listMock.mockResolvedValue([...LIST, skill('newbie')]);
    await act(async () => {
      vi.advanceTimersByTime(SKILLS_REFRESH_MS + 10);
    });
    expect(await screen.findByText('newbie')).toBeTruthy();
  });

  it('a skill whose folder was removed drops off the list on refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<SkillsView onFileOpen={vi.fn()} activeSkillId={null} />);
    expect(await screen.findByTestId('skill-row-broken')).toBeTruthy();
    listMock.mockResolvedValue([skill('alpha')]);
    await act(async () => {
      vi.advanceTimersByTime(SKILLS_REFRESH_MS + 10);
    });
    await waitFor(() => expect(screen.queryByTestId('skill-row-broken')).toBeNull());
    expect(screen.queryByText('Missing')).toBeNull();
  });

  // GET /api/skills never lists built-in skills, so a user with none of their
  // own gets the empty state even though every agent has the built-ins.
  it('shows the empty-state hint when the user has no skills of their own', async () => {
    listMock.mockResolvedValue([]);
    render(<SkillsView onFileOpen={vi.fn()} activeSkillId={null} />);
    expect(
      await screen.findByText(/Add a folder with a SKILL\.md under ~\/\.snaglet\/skills/)
    ).toBeTruthy();
  });
});

it('native sidebar disclosure lists files without opening or revealing them', async () => {
  const open = vi.fn();
  const view = render(<SkillsView onFileOpen={open} activeSkillId={null} />);
  await screen.findByText('alpha');
  await checkSidebarDisclosures(view.container, 'skills');
  expect(open).not.toHaveBeenCalled();
  expect(revealMock).not.toHaveBeenCalled();
  expect(filesMock).toHaveBeenCalled();
});
