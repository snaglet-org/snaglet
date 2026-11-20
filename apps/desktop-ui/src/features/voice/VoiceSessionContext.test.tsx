import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const mocks = vi.hoisted(() => ({
  dispatchMode: 'all' as 'all' | 'mentioned' | 'unsupported',
  start: vi.fn(),
  stop: vi.fn(),
  useVoiceSession: vi.fn(),
  voiceModelsGet: vi.fn(),
  voiceModelsInstall: vi.fn(),
}));

// The first-use model gate reads voice-model status before starting a session.
// Default: models already installed, so the gate passes through synchronously
// (after one microtask) for these routing/toggle tests. The gate's own prompt
// path is covered separately.
vi.mock('@desktop/utils/api', () => ({
  snagletHomeApi: {
    voiceModels: {
      get: mocks.voiceModelsGet,
      install: mocks.voiceModelsInstall,
    },
  },
}));

vi.mock('./useThreadDispatchMode.js', () => ({
  useThreadDispatchMode: () => mocks.dispatchMode,
}));

vi.mock('./useVoiceSession.js', () => ({
  useVoiceSession: mocks.useVoiceSession,
}));

import {
  VoiceSessionProvider,
  useVoiceSessionContext,
  type VoiceSessionContextValue,
} from './VoiceSessionContext';
import {
  ThreadRecipientProvider,
  useThreadRecipientContext,
  type ThreadRecipientContextValue,
} from './ThreadRecipientContext';
import { VoiceToggle } from './components/VoiceToggle';

// `phase` is a fixed mock value ('off'): api.start()/stop() are plain spies,
// as the real hook's phase only changes through its own state. The provider's
// start/stop effect reads `api.phase` each render, and dictateOn/speakOn
// flipping is what re-triggers it.
const api = {
  phase: 'off' as const,
  capturing: false,
  agentSpeaking: false,
  floorHolder: null,
  lastError: null,
  inputDevice: null,
  voiceSessionId: null,
  start: mocks.start,
  stop: mocks.stop,
  toggle: vi.fn(),
  pttPress: vi.fn(),
  pttRelease: vi.fn(),
  requestBail: vi.fn(),
};

let contextValue: VoiceSessionContextValue | null = null;
let recipientContextValue: ThreadRecipientContextValue | null = null;

function ContextProbe() {
  contextValue = useVoiceSessionContext();
  recipientContextValue = useThreadRecipientContext();
  return <VoiceToggle />;
}

function renderProvider() {
  return render(providerTree());
}

function providerTree() {
  return (
    <ThreadRecipientProvider
      threadId="thread-1"
      messages={[
        { role: 'assistant', agentId: 'agent-1' },
        { role: 'assistant', agentId: 'agent-2' },
      ]}
      participantAgentIds={['agent-1', 'agent-2']}
      agentNameById={
        new Map([
          ['agent-1', 'One'],
          ['agent-2', 'Two'],
        ])
      }
    >
      <VoiceSessionProvider threadId="thread-1">
        <ContextProbe />
      </VoiceSessionProvider>
    </ThreadRecipientProvider>
  );
}

describe('VoiceSessionProvider dispatch routing', () => {
  beforeEach(() => {
    contextValue = null;
    recipientContextValue = null;
    mocks.start.mockClear();
    mocks.stop.mockClear();
    mocks.useVoiceSession.mockReset();
    mocks.useVoiceSession.mockReturnValue(api);
    mocks.voiceModelsGet.mockReset();
    mocks.voiceModelsGet.mockResolvedValue({ state: 'ready' });
    mocks.voiceModelsInstall.mockReset();
  });

  it.each(['all', 'mentioned'] as const)(
    'allows voice in %s routing mode',
    async (dispatchMode) => {
      mocks.dispatchMode = dispatchMode;
      renderProvider();

      expect(contextValue?.dispatchAllowed).toBe(true);
      expect(contextValue?.blockedReason).toBeNull();
      expect(screen.getByTestId('voice-toggle')).toBeEnabled();

      // Clicking the Dictation toggle (VoiceToggle) runs the model gate (models
      // installed per the mock), which flips dictateOn — the context's
      // start/stop effect then calls the session's start() (phase mocked 'off').
      await act(async () => {
        fireEvent.click(screen.getByTestId('voice-toggle'));
      });
      expect(mocks.start).toHaveBeenCalledOnce();
    }
  );

  it('keeps one default voice target in broadcast mode', () => {
    mocks.dispatchMode = 'all';
    renderProvider();

    expect(recipientContextValue?.selectedAgentIds).toEqual(['agent-2']);
    expect(mocks.useVoiceSession).toHaveBeenLastCalledWith(
      'thread-1',
      expect.objectContaining({ targetAgentIds: ['agent-2'] })
    );
  });

  it('keeps the voice target synchronized with the shared recipient selection', () => {
    mocks.dispatchMode = 'mentioned';
    renderProvider();

    act(() => recipientContextValue?.toggleAgent('agent-1'));

    expect(mocks.useVoiceSession).toHaveBeenLastCalledWith(
      'thread-1',
      expect.objectContaining({ targetAgentIds: ['agent-2', 'agent-1'] })
    );
  });

  it('fails closed for an unknown routing mode', () => {
    mocks.dispatchMode = 'unsupported';
    renderProvider();

    expect(contextValue?.dispatchAllowed).toBe(false);
    expect(contextValue?.blockedReason).toBe('Voice is unavailable for this routing mode.');
    expect(screen.getByTestId('voice-toggle')).toBeDisabled();

    fireEvent.click(screen.getByTestId('voice-toggle'));
    expect(mocks.start).not.toHaveBeenCalled();
  });
});

describe('VoiceSessionProvider dictate/speak split', () => {
  beforeEach(() => {
    contextValue = null;
    recipientContextValue = null;
    mocks.start.mockClear();
    mocks.stop.mockClear();
    mocks.dispatchMode = 'all';
    mocks.useVoiceSession.mockReset();
    mocks.useVoiceSession.mockReturnValue(api);
    mocks.voiceModelsGet.mockReset();
    mocks.voiceModelsGet.mockResolvedValue({ state: 'ready' });
    mocks.voiceModelsInstall.mockReset();
  });

  it('starts with both dictateOn and speakOn false, and passes both flags to useVoiceSession', () => {
    renderProvider();
    expect(contextValue?.dictateOn).toBe(false);
    expect(contextValue?.speakOn).toBe(false);
    expect(mocks.useVoiceSession).toHaveBeenLastCalledWith(
      'thread-1',
      expect.objectContaining({ mode: 'open', dictate: false, speak: false })
    );
  });

  it('toggleDictate flips dictateOn independently of speakOn', async () => {
    renderProvider();
    await act(async () => contextValue?.toggleDictate());
    expect(mocks.useVoiceSession).toHaveBeenLastCalledWith(
      'thread-1',
      expect.objectContaining({ mode: 'open', dictate: true, speak: false })
    );
  });

  it('toggleSpeak flips speakOn AND implies dictate too (effectiveDictate ORs them)', async () => {
    renderProvider();
    await act(async () => contextValue?.toggleSpeak());
    expect(mocks.useVoiceSession).toHaveBeenLastCalledWith(
      'thread-1',
      expect.objectContaining({ mode: 'open', dictate: true, speak: true })
    );
  });

  it('toggleSpeak is blocked (and start is never called) when routing disallows voice', async () => {
    mocks.dispatchMode = 'unsupported';
    renderProvider();
    await act(async () => contextValue?.toggleSpeak());
    expect(contextValue?.speakOn).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('opens the first-use prompt (not a session) when models are missing', async () => {
    mocks.voiceModelsGet.mockResolvedValueOnce({ state: 'not-installed' });
    renderProvider();
    await act(async () => contextValue?.toggleSpeak());
    // Gate held the session: speak stays off, nothing started, prompt is open.
    expect(contextValue?.speakOn).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(contextValue?.firstUsePrompt).toEqual({ state: 'not-installed' });

    // Downloading then succeeding flips the pending toggle on with no restart.
    mocks.voiceModelsInstall.mockResolvedValueOnce({ state: 'ready' });
    await act(async () => contextValue?.confirmFirstUseDownload());
    expect(contextValue?.firstUsePrompt).toBeNull();
    expect(contextValue?.speakOn).toBe(true);
    expect(mocks.start).toHaveBeenCalled();
  });
});

// Per-mode gating from the status capabilities report
//
// The gate must respect what each mode needs for the active engine, not the
// single global install state. On macOS (Apple speech) Dictation needs no
// local model, so it must start with nothing downloaded and never show the
// prompt; Voice mode still needs VAD + TTS. On the all-local engine both modes
// need their components. These cases mock the status response's `capabilities`
// for each platform/engine.
describe('VoiceSessionProvider per-mode model gate', () => {
  beforeEach(() => {
    contextValue = null;
    mocks.dispatchMode = 'all';
    mocks.start.mockClear();
    mocks.stop.mockClear();
    mocks.useVoiceSession.mockReset();
    mocks.useVoiceSession.mockReturnValue(api);
    mocks.voiceModelsGet.mockReset();
    mocks.voiceModelsInstall.mockReset();
  });

  it('macOS Apple speech: Dictation starts with NO models and NO prompt', async () => {
    // Nothing on disk, but Apple speech backs dictation → dictate.ready true.
    mocks.voiceModelsGet.mockResolvedValue({
      state: 'not-installed',
      capabilities: {
        sttEngine: 'apple',
        dictate: { needs: [], ready: true },
        speak: { needs: ['vad', 'tts'], ready: false },
      },
    });
    renderProvider();
    await act(async () => contextValue?.toggleDictate());
    // Dictation turned on immediately; no prompt, session started.
    expect(contextValue?.dictateOn).toBe(true);
    expect(contextValue?.firstUsePrompt).toBeNull();
    expect(mocks.start).toHaveBeenCalled();
  });

  it('macOS Apple speech: Voice mode still prompts when VAD + TTS are missing', async () => {
    mocks.voiceModelsGet.mockResolvedValue({
      state: 'not-installed',
      capabilities: {
        sttEngine: 'apple',
        dictate: { needs: [], ready: true },
        speak: { needs: ['vad', 'tts'], ready: false },
      },
    });
    renderProvider();
    await act(async () => contextValue?.toggleSpeak());
    expect(contextValue?.speakOn).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(contextValue?.firstUsePrompt?.state).toBe('not-installed');
  });

  it('non-Mac local engine: Dictation prompts when STT + VAD are missing', async () => {
    mocks.voiceModelsGet.mockResolvedValue({
      state: 'not-installed',
      capabilities: {
        sttEngine: 'local',
        dictate: { needs: ['stt', 'vad'], ready: false },
        speak: { needs: ['stt', 'vad', 'tts'], ready: false },
      },
    });
    renderProvider();
    await act(async () => contextValue?.toggleDictate());
    expect(contextValue?.dictateOn).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(contextValue?.firstUsePrompt?.state).toBe('not-installed');
  });

  it('"Not now" does not permanently disable the toggle — a later press re-checks and can start', async () => {
    // First check: Voice mode not ready (local engine, nothing on disk) → prompt.
    mocks.voiceModelsGet.mockResolvedValueOnce({
      state: 'not-installed',
      capabilities: {
        sttEngine: 'local',
        dictate: { needs: ['stt', 'vad'], ready: false },
        speak: { needs: ['stt', 'vad', 'tts'], ready: false },
      },
    });
    renderProvider();
    await act(async () => contextValue?.toggleSpeak());
    expect(contextValue?.firstUsePrompt?.state).toBe('not-installed');

    // User dismisses with "Not now": prompt closes, toggle stays off but usable.
    await act(async () => contextValue?.dismissFirstUsePrompt());
    expect(contextValue?.firstUsePrompt).toBeNull();
    expect(contextValue?.speakOn).toBe(false);

    // Models have since been installed; a second press re-checks and starts,
    // so the toggle was not permanently disabled.
    mocks.voiceModelsGet.mockResolvedValueOnce({
      state: 'ready',
      capabilities: {
        sttEngine: 'local',
        dictate: { needs: ['stt', 'vad'], ready: true },
        speak: { needs: ['stt', 'vad', 'tts'], ready: true },
      },
    });
    await act(async () => contextValue?.toggleSpeak());
    expect(contextValue?.speakOn).toBe(true);
    expect(contextValue?.firstUsePrompt).toBeNull();
    expect(mocks.start).toHaveBeenCalled();
  });
});

describe('VoiceSessionProvider when the session ends on its own', () => {
  let phase: 'off' | 'connecting' = 'off';

  beforeEach(() => {
    contextValue = null;
    phase = 'off';
    mocks.start.mockClear();
    mocks.stop.mockClear();
    mocks.dispatchMode = 'all';
    mocks.useVoiceSession.mockReset();
    mocks.useVoiceSession.mockImplementation(() => ({ ...api, phase }));
    mocks.voiceModelsGet.mockReset();
    mocks.voiceModelsGet.mockResolvedValue({ state: 'ready' });
    mocks.voiceModelsInstall.mockReset();
  });

  it('turns the buttons off instead of restarting the failed session', async () => {
    const view = renderProvider();
    await act(async () => {
      fireEvent.click(screen.getByTestId('voice-toggle'));
    });
    expect(mocks.start).toHaveBeenCalledOnce();

    phase = 'connecting';
    view.rerender(providerTree());
    // The start fails (refused / no answer / mic blocked): the hook drops to
    // 'off' and reports onEnded in the same beat.
    phase = 'off';
    const { onEnded } = mocks.useVoiceSession.mock.lastCall![1] as { onEnded: () => void };
    act(() => onEnded());

    expect(contextValue?.dictateOn).toBe(false);
    expect(contextValue?.speakOn).toBe(false);
    expect(screen.getByTestId('voice-toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(mocks.start).toHaveBeenCalledOnce(); // no retry loop
  });
});
