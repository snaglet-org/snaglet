import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { ChipEditableInput } from './ChipEditableInput';

/**
 * Lifecycle cover for the native-file-drop registration, which reads
 * `editor.view.dom`. `editor.view` throws while the view is absent, and
 * `immediatelyRender: false` defers it, so the effect must guard the access.
 *
 * Caveat: jsdom mounts the view before the effect runs, so these pass with or
 * without the guard. They cover mount/unmount cycling in a toggling surface;
 * they do not prove the guard is needed.
 */
// jsdom has no layout engine, so it omits `elementFromPoint` — TipTap's
// placeholder extension calls it through posAtCoords while creating the view.
beforeAll(() => {
  if (!document.elementFromPoint) {
    document.elementFromPoint = () => null;
  }
});

const Harness = () => {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  return (
    <div>
      <button type="button" onClick={() => setOpen((prev) => !prev)}>
        toggle
      </button>
      {open && <ChipEditableInput value={value} onChange={setValue} ariaLabel="Prompt" multiline />}
    </div>
  );
};

describe('ChipEditableInput native file drop registration', () => {
  it('mounts without throwing while the view is still deferred', async () => {
    expect(() =>
      render(<ChipEditableInput value="" onChange={vi.fn()} ariaLabel="Prompt" />)
    ).not.toThrow();
    await waitFor(() => expect(screen.getByLabelText('Prompt')).toBeInTheDocument());
  });

  it('survives repeated mount/unmount inside a toggling surface', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: 'toggle' });

    for (let i = 0; i < 3; i += 1) {
      await user.click(toggle);
      await waitFor(() => expect(screen.getByLabelText('Prompt')).toBeInTheDocument());
      await user.click(toggle);
      await waitFor(() => expect(screen.queryByLabelText('Prompt')).not.toBeInTheDocument());
    }
  });
});
