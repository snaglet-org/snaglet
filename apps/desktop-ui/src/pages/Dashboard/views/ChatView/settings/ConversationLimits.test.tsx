import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChangeEvent, ComponentProps, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationLimits } from './ConversationLimits';
import { threadsApi, settingsApi, type ThreadSummary } from '@desktop/utils/api';

// Keep this state/API regression independent from the app-level component
// barrel, which also exports providers that require runtime Vite config.
vi.mock('@desktop/components', async () => {
  const { createElement } = await import('react');
  const Layout = ({ children }: { children?: ReactNode }) => createElement('div', null, children);

  return {
    Stack: Layout,
    Cluster: Layout,
    Section: ({ label, children }: { label?: ReactNode; children?: ReactNode }) =>
      createElement('section', null, label, children),
    RadioGroup: Layout,
    Radio: Layout,
    TextInput: ({
      containerClassName: _containerClassName,
      size: _size,
      ...props
    }: ComponentProps<'input'> & { containerClassName?: string }) => createElement('input', props),
    Checkbox: ({
      checked,
      onChange,
      disabled,
      children,
    }: {
      checked: boolean;
      onChange: (next: boolean) => void;
      disabled?: boolean;
      children?: ReactNode;
    }) =>
      createElement(
        'label',
        null,
        createElement('input', {
          type: 'checkbox',
          checked,
          disabled,
          onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.currentTarget.checked),
        }),
        children
      ),
    HelpTooltip: ({ ariaLabel, label }: { ariaLabel: string; label?: ReactNode }) =>
      createElement(
        'button',
        {
          type: 'button',
          'aria-label': ariaLabel,
          'data-help': typeof label === 'string' ? label : undefined,
        },
        '?'
      ),
  };
});

vi.mock('@desktop/utils/api', () => ({
  settingsApi: { registry: vi.fn() },
  threadsApi: {
    get: vi.fn(),
    listParticipants: vi.fn(),
    updateDispatchMode: vi.fn(),
    updateMaxWaves: vi.fn(),
    updateMaxTotalOutputTokens: vi.fn(),
  },
}));

const getThread = vi.mocked(threadsApi.get);
const updateMaxWaves = vi.mocked(threadsApi.updateMaxWaves);
const updateMaxTotalOutputTokens = vi.mocked(threadsApi.updateMaxTotalOutputTokens);

/**
 * Build a thread with the typed budget columns. `maxWaves` uses the wire
 * encoding: -1 means unbounded, null means "no override, use the settings
 * default".
 */
function threadWithBudget(budget: {
  maxWaves?: number | null;
  maxTotalOutputTokens?: number | null;
}): ThreadSummary {
  return {
    id: 'thread-1',
    agentId: 'agent-1',
    title: 'Test thread',
    projectId: null,
    maxAgentDispatches: 30,
    dispatchMode: 'all',
    maxWaves: budget.maxWaves ?? null,
    maxTotalOutputTokens: budget.maxTotalOutputTokens ?? null,
    threadSystemPrompt: null,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  };
}

beforeEach(() => {
  getThread.mockReset();
  vi.mocked(threadsApi.listParticipants).mockResolvedValue([]);
  vi.mocked(settingsApi.registry).mockResolvedValue([]);
  updateMaxWaves.mockReset();
  updateMaxTotalOutputTokens.mockReset();
});

describe('ConversationLimits help tooltips', () => {
  it('moves the waves and budget explanations into named help triggers', async () => {
    getThread.mockResolvedValue(threadWithBudget({}));
    render(<ConversationLimits threadId="thread-1" />);
    await screen.findByRole('spinbutton', { name: 'Output tokens' });

    const wavesHelp = screen.getByRole('button', { name: 'About max dispatch waves' });
    expect(wavesHelp.dataset.help).toMatch(
      /Default No limit; explicit values are honored exactly\./
    );
    expect(wavesHelp.dataset.help).toMatch(/No limit removes only this brake/);
    expect(wavesHelp.dataset.help).toMatch(/output-token budget or another stopping condition/);

    const budgetHelp = screen.getByRole('button', { name: 'About conversation budget' });
    expect(budgetHelp.dataset.help).toMatch(
      /Caps total output tokens across all agents for one message\./
    );
    expect(budgetHelp.dataset.help).toMatch(/runaway guard/);
    expect(budgetHelp.dataset.help).toMatch(/never shortens a single reply/);
    expect(budgetHelp.dataset.help).toMatch(/Leave blank to use the default/);
    // The blank field shows the real default: the 192k server ceiling.
    expect(screen.getByRole('spinbutton', { name: 'Output tokens' })).toHaveAttribute(
      'placeholder',
      '192000'
    );

    // The prose lives only in the tooltips; the inputs stay inline.
    expect(screen.queryByText(/Limits how many dispatch waves/)).toBeNull();
    expect(screen.getByRole('spinbutton', { name: 'Max dispatch waves' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'No limit' })).toBeInTheDocument();
  });
});

describe('ConversationLimits max waves', () => {
  it('shows an inherited finite global profile rather than falsely claiming No limit', async () => {
    getThread.mockResolvedValue(threadWithBudget({}));
    vi.mocked(settingsApi.registry).mockResolvedValue([
      {
        category: 'budget',
        key: 'solo',
        description: '',
        valueType: 'object',
        default: {},
        current: { maxWaves: 7 },
        isOverridden: true,
        updatedAt: null,
        updatedBy: null,
      },
    ]);
    render(<ConversationLimits threadId="thread-profile" />);
    await waitFor(() =>
      expect(screen.getByRole('spinbutton', { name: 'Max dispatch waves' })).toHaveValue(7)
    );
    expect(screen.getByRole('checkbox', { name: 'No limit' })).not.toBeChecked();
  });

  it('defaults an unset thread to No limit without writing settings', async () => {
    getThread.mockResolvedValue(threadWithBudget({}));
    render(<ConversationLimits threadId="thread-default" />);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'No limit' })).toBeChecked());
    expect(screen.getByRole('spinbutton', { name: 'Max dispatch waves' })).toBeDisabled();
    expect(updateMaxWaves).not.toHaveBeenCalled();
  });

  it('suggests a finite cap (24) when opting out of No limit, and does not persist a guessed cap when No limit is unticked', async () => {
    const user = userEvent.setup();
    getThread.mockResolvedValue(threadWithBudget({ maxWaves: -1 }));
    updateMaxWaves.mockImplementation(async (_threadId: string, maxWaves: number | null) =>
      threadWithBudget({ maxWaves: maxWaves === null ? -1 : maxWaves })
    );

    render(<ConversationLimits threadId="thread-1" />);

    // null persisted → No limit is checked, box shows genuinely unbounded.
    const noLimitBox = screen.getByRole('checkbox', { name: 'No limit' });
    const wavesInput = screen.getByRole('spinbutton', { name: 'Max dispatch waves' });
    await waitFor(() => expect(noLimitBox).toBeChecked());
    expect(wavesInput).toBeDisabled();

    await user.click(noLimitBox);

    expect(noLimitBox).not.toBeChecked();
    expect(wavesInput).toBeEnabled();
    // Unticking seeds a finite suggestion (24), not a guessed/blank value.
    expect(wavesInput).toHaveValue(24);
    expect(updateMaxWaves).not.toHaveBeenCalled();

    await user.clear(wavesInput);
    await user.type(wavesInput, '100');
    await user.tab();

    // Typed values are honored exactly — no server-side clamp to 24.
    // Each limit is its own column, so writing one cannot clobber another.
    await waitFor(() => expect(updateMaxWaves).toHaveBeenCalledWith('thread-1', 100));
  });

  it('checking No limit persists the null sentinel (genuinely unbounded, not clamped)', async () => {
    const user = userEvent.setup();
    getThread.mockResolvedValue(threadWithBudget({ maxWaves: 6 }));
    updateMaxWaves.mockImplementation(async (_threadId: string, maxWaves: number | null) =>
      threadWithBudget({ maxWaves: maxWaves === null ? -1 : maxWaves })
    );

    render(<ConversationLimits threadId="thread-1" />);

    const noLimitBox = screen.getByRole('checkbox', { name: 'No limit' });
    await waitFor(() => expect(noLimitBox).not.toBeChecked());

    await user.click(noLimitBox);

    await waitFor(() => expect(updateMaxWaves).toHaveBeenCalledWith('thread-1', null));
    await waitFor(() => expect(noLimitBox).toBeChecked());
  });
});

describe('ConversationLimits conversation budgets', () => {
  it('commits an output-token override on blur', async () => {
    const user = userEvent.setup();
    getThread.mockResolvedValue(threadWithBudget({ maxWaves: 6 }));
    updateMaxTotalOutputTokens.mockImplementation(
      async (_threadId: string, maxTotalOutputTokens: number | null) =>
        threadWithBudget({ maxWaves: 6, maxTotalOutputTokens })
    );

    render(<ConversationLimits threadId="thread-1" />);

    const tokensInput = await screen.findByRole('spinbutton', { name: 'Output tokens' });
    await user.clear(tokensInput);
    await user.type(tokensInput, '10000');
    await user.tab();

    await waitFor(() =>
      expect(updateMaxTotalOutputTokens).toHaveBeenCalledWith('thread-1', 10_000)
    );
  });

  it('does not write when the field is left unchanged', async () => {
    const user = userEvent.setup();
    getThread.mockResolvedValue(threadWithBudget({ maxWaves: 6, maxTotalOutputTokens: 5000 }));

    render(<ConversationLimits threadId="thread-1" />);

    const tokensInput = await screen.findByRole('spinbutton', { name: 'Output tokens' });
    await waitFor(() => expect(tokensInput).toHaveValue(5000));
    await user.click(tokensInput);
    await user.tab();

    expect(updateMaxTotalOutputTokens).not.toHaveBeenCalled();
    expect(screen.queryByText('Saved')).toBeNull();
  });
});

describe('ConversationLimits after a failed load', () => {
  it('keeps the limits locked so placeholder values cannot overwrite the thread', async () => {
    getThread.mockRejectedValue(new Error('thread unavailable'));

    render(<ConversationLimits threadId="thread-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('thread unavailable');
    expect(screen.getByRole('spinbutton', { name: 'Max dispatch waves' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Output tokens' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'No limit' })).toBeDisabled();
    expect(screen.queryByText('Up to date')).toBeNull();
  });
});
