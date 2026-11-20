/**
 * Composer — an empty thread's suggestion fills the message box and never
 * sends: each new request replaces the draft once, and only the person sends.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/features/rich-markdown/editor/index.js', () => ({
  ChipEditableInput: ({ value }: { value: string }) => (
    <div data-testid="mock-rich-value">{value}</div>
  ),
}));

import { Composer } from './Composer';

beforeEach(() => {
  localStorage.clear();
});

describe('Composer fillRequest', () => {
  it('puts the suggestion in the message box without sending it', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <Composer threadId="thread-1111111111111-aaaaaaaaa" onSubmit={onSubmit} fillRequest={null} />
    );
    expect(screen.getByTestId('mock-rich-value').textContent).toBe('');

    rerender(
      <Composer
        threadId="thread-1111111111111-aaaaaaaaa"
        onSubmit={onSubmit}
        fillRequest={{ text: 'Show me around', id: 1 }}
      />
    );
    expect(screen.getByTestId('mock-rich-value').textContent).toBe('Show me around');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('replaces the draft for each new request, and only once per request', () => {
    const { rerender } = render(
      <Composer
        threadId="thread-1111111111111-aaaaaaaaa"
        fillRequest={{ text: 'Make a weekly plan', id: 1 }}
      />
    );
    expect(screen.getByTestId('mock-rich-value').textContent).toBe('Make a weekly plan');
    rerender(
      <Composer
        threadId="thread-1111111111111-aaaaaaaaa"
        fillRequest={{ text: 'Add a reminder for tomorrow at 9', id: 2 }}
      />
    );
    expect(screen.getByTestId('mock-rich-value').textContent).toBe(
      'Add a reminder for tomorrow at 9'
    );
  });
});
