/** The Dictation button. Release voice capture is continuous Open/server-VAD;
 * Push-to-talk and its capture-mode selector must not return to the UI. */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const ctxHolder = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../VoiceSessionContext.js', () => ({
  useVoiceSessionContext: () => ctxHolder.value,
}));

import { VoiceToggle } from './VoiceToggle';

function fakeCtx(
  overrides: { dictateOn?: boolean; phase?: string; lastError?: string | null } = {}
) {
  return {
    dictateOn: overrides.dictateOn ?? false,
    dispatchAllowed: true,
    blockedReason: null,
    toggleDictate: vi.fn(),
    api: {
      phase: overrides.phase ?? 'off',
      inputDevice: null,
      lastError: overrides.lastError ?? null,
    },
  };
}

describe('VoiceToggle', () => {
  it('shows the Dictation toggle without Push-to-talk or capture-mode controls', () => {
    ctxHolder.value = fakeCtx();
    render(<VoiceToggle />);
    expect(screen.getByTestId('voice-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('voice-mic-button')).toBeNull();
    expect(screen.queryByTestId('voice-mode-toggle')).toBeNull();
    expect(screen.queryByText('Push')).toBeNull();
  });

  it('turns dictation on when clicked', () => {
    const ctx = fakeCtx();
    ctxHolder.value = ctx;
    render(<VoiceToggle />);
    fireEvent.click(screen.getByTestId('voice-toggle'));
    expect(ctx.toggleDictate).toHaveBeenCalledOnce();
  });

  it('says the microphone is still starting instead of claiming to record', () => {
    ctxHolder.value = fakeCtx({ dictateOn: true, phase: 'idle' });
    render(<VoiceToggle />);
    expect(screen.getByTestId('voice-toggle')).toHaveAttribute(
      'title',
      'Starting microphone… — click to turn off dictation'
    );
  });

  it('keeps the reason a start failed on the button once the toast is gone', () => {
    ctxHolder.value = fakeCtx({
      lastError: 'No microphone was found. Connect one, then try again.',
    });
    render(<VoiceToggle />);
    expect(screen.getByTestId('voice-toggle')).toHaveAttribute(
      'title',
      'No microphone was found. Connect one, then try again. — click to try again'
    );
  });
});
