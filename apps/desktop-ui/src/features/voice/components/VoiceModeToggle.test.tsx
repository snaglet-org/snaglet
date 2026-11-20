/** Release Voice mode is one hands-free Open/server-VAD path. */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const ctxHolder = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../VoiceSessionContext.js', () => ({
  useVoiceSessionContext: () => ctxHolder.value,
}));

import { VoiceModeToggle } from './VoiceModeToggle';

function fakeCtx(overrides: { speakOn?: boolean; dispatchAllowed?: boolean } = {}) {
  return {
    speakOn: overrides.speakOn ?? false,
    dispatchAllowed: overrides.dispatchAllowed ?? true,
    blockedReason: overrides.dispatchAllowed === false ? 'Voice unavailable' : null,
    toggleSpeak: vi.fn(),
    toggleDictate: vi.fn(),
    api: { phase: 'off' },
  };
}

describe('VoiceModeToggle', () => {
  it('toggles hands-free Voice mode and never renders Push-to-talk choices', () => {
    const ctx = fakeCtx({ speakOn: true });
    ctxHolder.value = ctx;
    render(<VoiceModeToggle />);
    fireEvent.click(screen.getByTestId('voice-mode-button'));
    expect(ctx.toggleSpeak).toHaveBeenCalledOnce();
    expect(ctx.toggleDictate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('voice-mode-toggle')).toBeNull();
    expect(screen.queryByText('Push')).toBeNull();
  });

  it('is disabled when routing mode blocks voice', () => {
    ctxHolder.value = fakeCtx({ dispatchAllowed: false });
    render(<VoiceModeToggle />);
    expect(screen.getByTestId('voice-mode-button')).toBeDisabled();
  });

  it('renders nothing outside a VoiceSessionProvider', () => {
    ctxHolder.value = null;
    const { container } = render(<VoiceModeToggle />);
    expect(container).toBeEmptyDOMElement();
  });
});
