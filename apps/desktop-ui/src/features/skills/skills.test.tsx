/**
 * Agent and thread-agent skill assignment UI. API mocked.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillInfo, ThreadSkillState } from '@desktop/utils/api/skills';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  list: vi.fn(),
  agentSkills: vi.fn(),
  setAgentSkills: vi.fn(),
  threadSkills: vi.fn(),
  setThreadSkills: vi.fn(),
}));
vi.mock('@desktop/utils/api/skills', () => ({ skillsApi: api }));

import { emitAgentEvent } from '@desktop/utils/agentEvents';
import { AgentSkillsSection } from './AgentSkillsSection';
import { ThreadSkillsSection } from './ThreadSkillsSection';

function skill(slug: string, over: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id: `skill-${slug}`,
    slug,
    name: slug,
    description: `${slug} does things`,
    status: 'valid',
    error: null,
    sourcePath: `/s/${slug}/SKILL.md`,
    folderPath: `/s/${slug}`,
    version: 'abcd1234',
    indexedAt: '',
    ...over,
  };
}

const release = skill('release');
const review = skill('review');
const broken = skill('broken', { status: 'invalid', error: 'missing description' });

function threadState(over: Partial<ThreadSkillState> = {}): ThreadSkillState {
  return {
    mode: 'inherit',
    threadSkillIds: [],
    generalSkillIds: [],
    resolved: { effective: [], dropped: [] },
    ...over,
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.list.mockResolvedValue([broken, release, review]);
});

afterEach(() => vi.useRealTimers());

async function openAdd(label = /Add to Agent skills/) {
  const box = await screen.findByRole('combobox', { name: label });
  fireEvent.click(box);
  return box;
}

function optionTexts(): string[] {
  return screen.queryAllByRole('option').map((o) => o.textContent ?? '');
}

describe('AgentSkillsSection', () => {
  it('lists assigned skills with slug and description, not in the dropdown', async () => {
    api.agentSkills.mockResolvedValue({ skillIds: ['skill-release'] });
    render(<AgentSkillsSection agentId="agent-1" />);
    const list = await screen.findByRole('list', { name: 'Agent skills' });
    expect(within(list).getByText('release')).toBeInTheDocument();
    expect(within(list).getByText('release does things')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    await openAdd();
    const texts = optionTexts();
    expect(texts.some((t) => t.startsWith('review'))).toBe(true);
    expect(texts.some((t) => t.startsWith('release'))).toBe(false);
  });

  it('filters by slug, name or description as you type', async () => {
    api.list.mockResolvedValue([
      release,
      review,
      skill('deploy', { name: 'Ship it', description: 'pushes builds to prod' }),
    ]);
    api.agentSkills.mockResolvedValue({ skillIds: [] });
    render(<AgentSkillsSection agentId="agent-1" />);
    const box = await openAdd();

    fireEvent.change(box, { target: { value: 'rev' } });
    expect(optionTexts()).toHaveLength(1);
    expect(optionTexts()[0]).toMatch(/^review/);
    fireEvent.change(box, { target: { value: 'ship' } });
    expect(optionTexts()[0]).toMatch(/^deploy/);
    fireEvent.change(box, { target: { value: 'PROD' } });
    expect(optionTexts()[0]).toMatch(/^deploy/);
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText('No matching skills')).toBeInTheDocument();
  });

  it('adds with the keyboard (arrows + Enter) and keeps focus in the box', async () => {
    api.agentSkills.mockResolvedValue({ skillIds: [] });
    api.setAgentSkills.mockImplementation(async (_a: string, ids: string[]) => ({
      skillIds: ids,
    }));
    render(<AgentSkillsSection agentId="agent-1" />);
    const box = await openAdd();
    box.focus();
    // Options: broken (invalid, skipped), release, review. First active is release.
    expect(box).toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(api.setAgentSkills).toHaveBeenCalledWith('agent-1', ['skill-review'])
    );
    const list = await screen.findByRole('list', { name: 'Agent skills' });
    expect(within(list).getByText('review')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(box);
  });

  it('adds with the mouse and removes with the remove control', async () => {
    api.agentSkills.mockResolvedValue({ skillIds: ['skill-review'] });
    api.setAgentSkills.mockImplementation(async (_a: string, ids: string[]) => ({
      skillIds: ids,
    }));
    render(<AgentSkillsSection agentId="agent-1" />);
    await openAdd();
    fireEvent.mouseDown(screen.getByRole('option', { name: /release/ }));
    await waitFor(() =>
      expect(api.setAgentSkills).toHaveBeenLastCalledWith('agent-1', [
        'skill-release',
        'skill-review',
      ])
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Remove review' }));
    await waitFor(() =>
      expect(api.setAgentSkills).toHaveBeenLastCalledWith('agent-1', ['skill-release'])
    );
    const list = await screen.findByRole('list', { name: 'Agent skills' });
    await waitFor(() => expect(within(list).queryByText('review')).not.toBeInTheDocument());
  });

  it('removing a skill focuses the box without opening the dropdown', async () => {
    api.agentSkills.mockResolvedValue({ skillIds: ['skill-review'] });
    api.setAgentSkills.mockImplementation(async (_a: string, ids: string[]) => ({
      skillIds: ids,
    }));
    render(<AgentSkillsSection agentId="agent-1" />);
    const box = await screen.findByRole('combobox', { name: /Add to Agent skills/ });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove review' }));
    await waitFor(() => expect(api.setAgentSkills).toHaveBeenLastCalledWith('agent-1', []));
    await waitFor(() => expect(document.activeElement).toBe(box));
    fireEvent.focus(box);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(box).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows an invalid skill with its error but cannot add it', async () => {
    api.agentSkills.mockResolvedValue({ skillIds: [] });
    render(<AgentSkillsSection agentId="agent-1" />);
    const box = await openAdd();
    const opt = screen.getByRole('option', { name: /broken/ });
    expect(opt).toHaveAttribute('aria-disabled', 'true');
    expect(within(opt).getByText('missing description')).toBeInTheDocument();

    fireEvent.mouseDown(opt);
    // Arrows skip it, and filtering down to only it makes Enter a no-op.
    fireEvent.change(box, { target: { value: 'broken' } });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box).not.toHaveAttribute('aria-activedescendant');
    expect(api.setAgentSkills).not.toHaveBeenCalled();
  });

  it('closes on Escape without leaving the box', async () => {
    api.agentSkills.mockResolvedValue({ skillIds: [] });
    render(<AgentSkillsSection agentId="agent-1" />);
    const box = await openAdd();
    box.focus();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(box).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(box);
    // ArrowDown reopens.
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('shows a quiet "No skills" line when nothing is assigned', async () => {
    api.agentSkills.mockResolvedValue({ skillIds: [] });
    render(<AgentSkillsSection agentId="agent-1" />);
    expect(await screen.findByText('No skills')).toBeInTheDocument();
  });

  it('does not claim a first skill adds the skill tool: every agent has it (built-ins)', async () => {
    api.agentSkills.mockResolvedValue({ skillIds: [] });
    render(<AgentSkillsSection agentId="agent-1" />);
    expect(await screen.findByText(/Skills this agent can load/)).toBeInTheDocument();
    expect(screen.queryByText(/fresh prompt cache/)).not.toBeInTheDocument();
  });

  it('reverts and shows the error when a save fails', async () => {
    api.agentSkills.mockResolvedValue({ skillIds: [] });
    api.setAgentSkills.mockRejectedValue(new Error('boom'));
    render(<AgentSkillsSection agentId="agent-1" />);
    await openAdd();
    fireEvent.mouseDown(screen.getByRole('option', { name: /release/ }));
    expect(await screen.findByText(/Could not save: boom/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Agent skills' })).not.toBeInTheDocument();
    expect(screen.getByText('No skills')).toBeInTheDocument();
  });

  // The API lists only the user's own skills (built-ins never), so a user with
  // none of their own sees this empty state even though built-ins exist.
  it('points at ~/.snaglet/skills inside the dropdown when there are no skills', async () => {
    api.list.mockResolvedValue([]);
    api.agentSkills.mockResolvedValue({ skillIds: [] });
    render(<AgentSkillsSection agentId="agent-1" />);
    await openAdd();
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByText(/No skills yet/)).toBeInTheDocument();
    expect(within(listbox).getByText('~/.snaglet/skills')).toBeInTheDocument();
  });
});

describe('AgentSkillsSection live updates', () => {
  const skillsChanged = (agentId: string) =>
    act(() => {
      emitAgentEvent({
        type: 'agent.updated',
        agentId,
        changed: ['skills'],
        ts: '2026-11-16T10:00:00.000Z',
        actor: { actorId: 'agent-venus', actorKind: 'agent', actorName: 'Venus' },
      });
    });

  it('shows skills an agent’s tool assigned while the pane is open, and says so', async () => {
    api.agentSkills.mockResolvedValueOnce({ skillIds: ['skill-review'] });
    const onRemoteChange = vi.fn();
    render(<AgentSkillsSection agentId="agent-1" onRemoteChange={onRemoteChange} />);
    const list = await screen.findByRole('list', { name: 'Agent skills' });
    expect(within(list).queryByText('release')).not.toBeInTheDocument();

    api.agentSkills.mockResolvedValueOnce({ skillIds: ['skill-review', 'skill-release'] });
    skillsChanged('agent-1');

    await waitFor(() => expect(within(list).getByText('release')).toBeInTheDocument());
    expect(onRemoteChange).toHaveBeenCalledTimes(1);
  });

  it('does not take its own save’s echo for someone else’s change', async () => {
    // Until the save answers, the server still lists the old set: a reread
    // then would undo the pick on screen and read as a remote change.
    let saved = false;
    api.agentSkills.mockImplementation(async () => ({
      skillIds: saved ? ['skill-release', 'skill-review'] : ['skill-review'],
    }));
    let answer: (value: { skillIds: string[] }) => void = () => undefined;
    api.setAgentSkills.mockImplementation(
      () => new Promise<{ skillIds: string[] }>((resolve) => (answer = resolve))
    );
    const onRemoteChange = vi.fn();
    render(<AgentSkillsSection agentId="agent-1" onRemoteChange={onRemoteChange} />);
    await openAdd();
    fireEvent.mouseDown(screen.getByRole('option', { name: /release/ }));

    // The echo lands before the save answers.
    skillsChanged('agent-1');
    await act(async () => undefined);
    saved = true;
    await act(async () => answer({ skillIds: ['skill-release', 'skill-review'] }));

    await waitFor(() => expect(api.agentSkills).toHaveBeenCalledTimes(2));
    const list = await screen.findByRole('list', { name: 'Agent skills' });
    expect(within(list).getByText('release')).toBeInTheDocument();
    expect(onRemoteChange).not.toHaveBeenCalled();
  });

  it('drops a reread that a save overtook, so the stale list never lands', async () => {
    api.agentSkills.mockResolvedValueOnce({ skillIds: ['skill-review'] });
    const onRemoteChange = vi.fn();
    render(<AgentSkillsSection agentId="agent-1" onRemoteChange={onRemoteChange} />);
    const list = await screen.findByRole('list', { name: 'Agent skills' });

    // A reread starts (someone else's change)...
    let answerRead: (value: { skillIds: string[] }) => void = () => undefined;
    api.agentSkills.mockImplementationOnce(
      () => new Promise<{ skillIds: string[] }>((resolve) => (answerRead = resolve))
    );
    skillsChanged('agent-1');
    // ...then the user adds a skill, and that save lands first.
    api.setAgentSkills.mockResolvedValue({ skillIds: ['skill-release', 'skill-review'] });
    api.agentSkills.mockResolvedValue({ skillIds: ['skill-release', 'skill-review'] });
    await openAdd();
    fireEvent.mouseDown(screen.getByRole('option', { name: /release/ }));
    await waitFor(() => expect(api.setAgentSkills).toHaveBeenCalled());
    await act(async () => undefined);

    // The older read answers with the list from before the save.
    await act(async () => answerRead({ skillIds: [] }));

    await waitFor(() => expect(within(list).getByText('release')).toBeInTheDocument());
    expect(within(list).getByText('review')).toBeInTheDocument();
    expect(onRemoteChange).not.toHaveBeenCalled();
  });

  it('ignores another agent’s skills', async () => {
    api.agentSkills.mockResolvedValue({ skillIds: ['skill-review'] });
    render(<AgentSkillsSection agentId="agent-1" />);
    await screen.findByRole('list', { name: 'Agent skills' });

    skillsChanged('agent-2');

    expect(api.agentSkills).toHaveBeenCalledTimes(1);
  });
});

describe('ThreadSkillsSection', () => {
  it('renders nothing when the user has no skills (built-ins are never listed)', async () => {
    api.list.mockResolvedValue([]);
    api.threadSkills.mockResolvedValue(threadState());
    const { container } = render(
      <ThreadSkillsSection threadId="t1" agentId="a1" agentName="Venus" />
    );
    await act(async () => {});
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the section for an agent with no skills of its own (Add path)', async () => {
    api.threadSkills.mockResolvedValue(threadState());
    render(<ThreadSkillsSection threadId="t1" agentId="a1" agentName="Venus" />);
    expect(await screen.findByRole('radiogroup', { name: /Skill mode for Venus/ })).toBeVisible();
    expect(screen.getByText('No skills.')).toBeInTheDocument();
    // Inherit hides the picker.
    expect(screen.queryByRole('combobox', { name: /Thread skills/ })).not.toBeInTheDocument();
  });

  it('switches mode and picks thread skills', async () => {
    api.threadSkills.mockResolvedValue(threadState());
    api.setThreadSkills.mockImplementation(
      async (_t: string, _a: string, patch: { mode?: string; skillIds?: string[] }) =>
        threadState({
          mode: (patch.mode ?? 'add') as ThreadSkillState['mode'],
          threadSkillIds: patch.skillIds ?? [],
          resolved: {
            effective: (patch.skillIds ?? []).map((id) => ({
              skill: id === 'skill-review' ? review : release,
              origin: 'thread' as const,
            })),
            dropped: [],
          },
        })
    );
    render(<ThreadSkillsSection threadId="t1" agentId="a1" agentName="Venus" />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Add' }));
    await waitFor(() =>
      expect(api.setThreadSkills).toHaveBeenCalledWith('t1', 'a1', { mode: 'add' })
    );

    await openAdd(/Add to Thread skills for Venus/);
    fireEvent.mouseDown(screen.getByRole('option', { name: /review/ }));
    await waitFor(() =>
      expect(api.setThreadSkills).toHaveBeenLastCalledWith('t1', 'a1', {
        skillIds: ['skill-review'],
      })
    );
    const list = await screen.findByRole('list', { name: 'Effective skills' });
    await waitFor(() => expect(within(list).getByText('review')).toBeInTheDocument());
    expect(within(list).getByText('thread')).toBeInTheDocument();
    // Every agent already has the skill tool (built-ins), so no first-skill note.
    expect(screen.queryByText(/fresh prompt cache/)).not.toBeInTheDocument();
  });

  it('lists effective skills by origin and dropped skills with their reason', async () => {
    api.threadSkills.mockResolvedValue(
      threadState({
        mode: 'add',
        generalSkillIds: ['skill-release', 'skill-gone'],
        threadSkillIds: ['skill-broken'],
        resolved: {
          effective: [{ skill: release, origin: 'general' }],
          dropped: [
            { skillId: 'skill-gone', origin: 'general', reason: 'unknown' },
            { skillId: 'skill-broken', origin: 'thread', reason: 'invalid' },
          ],
        },
      })
    );
    render(<ThreadSkillsSection threadId="t1" agentId="a1" agentName="Venus" />);
    const list = await screen.findByRole('list', { name: 'Effective skills' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(/release\s*agent/);
    expect(items[1]).toHaveTextContent(/skill-gone.*dropped: no longer exists/);
    expect(items[2]).toHaveTextContent(/broken.*thread.*dropped: invalid SKILL\.md/);
    // An assigned invalid skill can still be removed.
    expect(screen.getByRole('button', { name: 'Remove broken' })).toBeEnabled();
  });
});
