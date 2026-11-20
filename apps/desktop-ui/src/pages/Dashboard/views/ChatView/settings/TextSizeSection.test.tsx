/**
 * TextSizeSection — the General tab's per-thread Text size control. Picking a
 * size applies live to anything showing that thread and is kept per thread.
 */

import { render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setThreadTextSize, useThreadTextSize } from '../threadTextSize';
import { TextSizeSection } from './TextSizeSection';

const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
const OTHER_THREAD_ID = 'thread-2222222222222-bbbbbbbbb';

afterEach(() => {
  setThreadTextSize(THREAD_ID, 'small');
  setThreadTextSize(OTHER_THREAD_ID, 'small');
  window.localStorage.clear();
});

describe('TextSizeSection', () => {
  it('offers Small, Medium, Large and Extra large, with Small selected by default', () => {
    render(<TextSizeSection threadId={THREAD_ID} />);
    expect(screen.getByRole('heading', { name: /Text size/ })).toBeInTheDocument();
    const names = screen.getAllByRole('radio').map((radio) => radio.textContent);
    expect(names).toEqual(['Small', 'Medium', 'Large', 'Extra large']);
    expect(screen.getByRole('radio', { name: 'Small' })).toHaveAttribute('aria-checked', 'true');
  });

  it('applies the picked size live to this thread only, and keeps it', async () => {
    const user = userEvent.setup();
    const chat = renderHook(() => useThreadTextSize(THREAD_ID));
    const other = renderHook(() => useThreadTextSize(OTHER_THREAD_ID));
    render(<TextSizeSection threadId={THREAD_ID} />);

    await user.click(screen.getByRole('radio', { name: 'Extra large' }));

    expect(screen.getByRole('radio', { name: 'Extra large' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(chat.result.current).toBe('xlarge');
    expect(other.result.current).toBe('small');
    expect(window.localStorage.getItem(`snaglet.dashboard.chat.textSize.${THREAD_ID}`)).toBe(
      'xlarge'
    );
  });

  it('shows the size already chosen for the thread', () => {
    setThreadTextSize(THREAD_ID, 'medium');
    render(<TextSizeSection threadId={THREAD_ID} />);
    expect(screen.getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
  });
});
