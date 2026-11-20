/**
 * ClarificationPrompt — the Ask form (historical get_clarification). Pins the answer
 * round-trips (single/multi select, allowOther free text), maxSelect
 * enforcement, and the sessionStorage draft: persisted per callId, restored
 * across a remount, ignored when stale, cleared on submit/skip.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClarificationQuestion, ClarificationRequestPayload } from '@snaglet/shared/types';
import { ClarificationPrompt } from './ClarificationPrompt';

const singleSelect: ClarificationQuestion = {
  id: 'q_deploy',
  prompt: 'Pick a deploy target',
  type: 'single_select',
  options: ['staging', 'production'],
  allowOther: true,
};

const multiSelect: ClarificationQuestion = {
  id: 'q_scope',
  prompt: 'Pick scopes',
  type: 'multi_select',
  options: ['read', 'write', 'admin'],
  maxSelect: 2,
  allowOther: true,
};

const textQuestion: ClarificationQuestion = {
  id: 'q_notes',
  prompt: 'Anything else?',
  type: 'text',
};

function payload(questions: ClarificationQuestion[]): ClarificationRequestPayload {
  return { threadId: 'thread-1', callId: 'call-1', request: { questions } };
}

const DRAFT_KEY = 'snaglet:clarification-draft:call-1';

beforeEach(() => {
  sessionStorage.clear();
});

describe('ClarificationPrompt', () => {
  it('answers a single_select, round-trips it, and clears the draft on submit', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(<ClarificationPrompt request={payload([singleSelect])} onRespond={onRespond} />);

    // Required and unanswered → submit gated.
    expect(screen.getByRole('button', { name: 'Send answers' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'staging' }));
    await user.click(screen.getByRole('button', { name: 'Send answers' }));

    expect(onRespond).toHaveBeenCalledWith('call-1', 'answered', {
      q_deploy: { selected: ['staging'], text: null },
    });
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('round-trips an allowOther free-text answer on a select', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(<ClarificationPrompt request={payload([singleSelect])} onRespond={onRespond} />);

    // Focusing the Other field selects the Other option automatically.
    await user.type(screen.getByPlaceholderText('…'), 'a canary box');
    await user.click(screen.getByRole('button', { name: 'Send answers' }));

    expect(onRespond).toHaveBeenCalledWith('call-1', 'answered', {
      q_deploy: { selected: [], text: 'a canary box' },
    });
  });

  it('enforces maxSelect on multi_select and merges picks with Other text', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(<ClarificationPrompt request={payload([multiSelect])} onRespond={onRespond} />);

    await user.click(screen.getByRole('button', { name: 'read' }));
    await user.click(screen.getByRole('button', { name: 'Other:' }));
    await user.type(screen.getByPlaceholderText('…'), 'audit');
    // Third pick is over maxSelect=2 (Other counts) → ignored.
    await user.click(screen.getByRole('button', { name: 'write' }));
    await user.click(screen.getByRole('button', { name: 'Send answers' }));

    expect(onRespond).toHaveBeenCalledWith('call-1', 'answered', {
      q_scope: { selected: ['read'], text: 'audit' },
    });
  });

  it('restores an in-progress draft across a remount and submits the full set', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    const view = render(
      <ClarificationPrompt request={payload([singleSelect, textQuestion])} onRespond={onRespond} />
    );

    await user.click(screen.getByRole('button', { name: 'staging' }));
    await user.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(screen.getByText('Anything else?')).toBeInTheDocument();
    expect(sessionStorage.getItem(DRAFT_KEY)).not.toBeNull();

    // Pane remount (layout rearrange / refresh) — the draft brings back
    // both the step and the earlier answer.
    view.unmount();
    render(
      <ClarificationPrompt request={payload([singleSelect, textQuestion])} onRespond={onRespond} />
    );
    expect(screen.getByText('Anything else?')).toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Type your answer…'), 'ship it');
    await user.click(screen.getByRole('button', { name: 'Send answers' }));

    expect(onRespond).toHaveBeenCalledWith('call-1', 'answered', {
      q_deploy: { selected: ['staging'], text: null },
      q_notes: { text: 'ship it' },
    });
  });

  it('ignores a stale draft that does not cover the current question set', () => {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ step: 1, state: { some_old_question: { selected: ['x'], otherText: '' } } })
    );
    render(<ClarificationPrompt request={payload([singleSelect])} onRespond={vi.fn()} />);

    expect(screen.getByText('Pick a deploy target')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send answers' })).toBeDisabled();
  });

  it('Skip dismisses with empty answers and clears the draft', async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn();
    render(<ClarificationPrompt request={payload([singleSelect])} onRespond={onRespond} />);

    await user.click(screen.getByRole('button', { name: 'staging' })); // draft written
    await user.click(screen.getByRole('button', { name: 'Skip' }));

    expect(onRespond).toHaveBeenCalledWith('call-1', 'dismissed', {});
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('names its fields and says which options are picked', async () => {
    const user = userEvent.setup();
    render(
      <ClarificationPrompt request={payload([singleSelect, textQuestion])} onRespond={vi.fn()} />
    );

    const staging = screen.getByRole('button', { name: 'staging' });
    expect(staging).toHaveAttribute('aria-pressed', 'false');
    await user.click(staging);
    expect(staging).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Other answer' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(screen.getByRole('textbox', { name: 'Anything else?' })).toBeInTheDocument();
  });
});
