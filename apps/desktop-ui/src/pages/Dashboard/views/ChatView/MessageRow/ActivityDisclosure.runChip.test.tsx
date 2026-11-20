/**
 * ActivityDisclosure — the run chip in the summary copies the run id, from
 * a click or from Enter/Space, without toggling the disclosure it sits in.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { ActivityDisclosure } from './ActivityDisclosure';
import type { RunActivity } from '../hooks/types';

const RUN_ID = 'run-1111111111111-aaaaaaaaa';

const activity: RunActivity = {
  runId: RUN_ID,
  agentId: 'test-agent-a',
  threadId: 'thread-1',
  steps: [],
  status: 'complete',
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: '2026-01-01T00:00:05Z',
};

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

function renderChip() {
  const { container } = render(<ActivityDisclosure activity={activity} agentName="Test Agent" />);
  const details = container.querySelector('details')!;
  const chip = container.querySelector<HTMLElement>(`[data-run-chip="${RUN_ID}"]`)!;
  return { details, chip };
}

describe('ActivityDisclosure — run chip', () => {
  it('copies the run id on click and leaves the disclosure closed', async () => {
    const { details, chip } = renderChip();

    fireEvent.click(chip);

    expect(writeText).toHaveBeenCalledWith(RUN_ID);
    await waitFor(() => expect(chip).toHaveTextContent('copied'));
    expect(details.open).toBe(false);
  });

  it('copies the run id from the keyboard', async () => {
    const { chip } = renderChip();

    fireEvent.keyDown(chip, { key: 'Enter' });
    fireEvent.keyDown(chip, { key: ' ' });
    fireEvent.keyDown(chip, { key: 'a' });

    expect(writeText).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByText('copied')).toBeInTheDocument());
  });
});
