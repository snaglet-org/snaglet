/**
 * When the agents API keeps failing, the `@` list and the typed-mention
 * autocomplete ask a bounded number of times, then the list says it couldn't
 * load agents. Typing on does not start the requests again; opening a new
 * mention does.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const mocks = vi.hoisted(() => ({ tieredSearch: vi.fn(), agents: vi.fn() }));

vi.mock('@desktop/hooks/useTieredSearch', () => ({
  useTieredSearch: mocks.tieredSearch,
  stableMergeById: <T,>(instant: readonly T[], enriched: readonly T[]) => [...instant, ...enriched],
}));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: mocks.agents } };
});

import { ChipEditableInput } from './ChipEditableInput';
import { AGENT_LOAD_ATTEMPTS } from './agentMentionCache';

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

beforeEach(() => {
  // Testing Library drains each user-event step with a zero timeout and only
  // advances it under Jest's fake timers; point that at Vitest's.
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.agents.mockReset();
  mocks.agents.mockRejectedValue(new Error('agents API down'));
  mocks.tieredSearch.mockReturnValue({
    instant: null,
    enriched: null,
    instantLoading: false,
    enrichmentLoading: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('agent mentions while the agents API keeps failing', () => {
  it('asks a few times, says it could not load agents, and stops asking', async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <ChipEditableInput
        value=""
        onChange={vi.fn()}
        ariaLabel="Agent"
        mentionKinds={['agent']}
        mentionOnType
      />
    );
    const input = await screen.findByRole('textbox', { name: 'Agent' });
    // Fake timers from here: the retry waits are what is being counted.
    vi.useFakeTimers();
    await user.click(input);
    await user.keyboard('Mi');
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(screen.getByRole('status')).toHaveTextContent("Couldn't load agents");
    expect(mocks.agents).toHaveBeenCalledTimes(AGENT_LOAD_ATTEMPTS);

    // Typing on, and waiting, start no new requests.
    await user.keyboard('lo ');
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(mocks.agents).toHaveBeenCalledTimes(AGENT_LOAD_ATTEMPTS);
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't load agents");
  });

  it('tries again, bounded, when a new mention opens', async () => {
    const user = userEvent.setup({ delay: null });
    render(<ChipEditableInput value="" onChange={vi.fn()} multiline ariaLabel="Prompt" />);
    const input = await screen.findByRole('textbox', { name: 'Prompt' });
    vi.useFakeTimers();
    await user.click(input);
    await user.keyboard('@cl');
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't load agents");
    expect(mocks.agents).toHaveBeenCalledTimes(AGENT_LOAD_ATTEMPTS);

    await user.keyboard('{Escape} and @');
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(mocks.agents).toHaveBeenCalledTimes(AGENT_LOAD_ATTEMPTS * 2);

    mocks.agents.mockResolvedValue([{ id: 'test-agent-a', name: 'Test Agent A' }]);
    await user.keyboard('{Escape} then @');
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(mocks.agents).toHaveBeenCalledTimes(AGENT_LOAD_ATTEMPTS * 2 + 1);
    expect(screen.queryByText("Couldn't load agents")).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Test Agent A/ })).toBeInTheDocument();
  });
});
