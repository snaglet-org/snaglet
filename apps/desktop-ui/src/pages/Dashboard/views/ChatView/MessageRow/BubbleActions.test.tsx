/**
 * BubbleActions: the ▶ LISTEN re-listen button. It renders on agent and user
 * messages, a click POSTs /voice/speak-message and plays the reply, a second
 * click (here or on another message) stops the current playback, and none of
 * it needs a voice session.
 */
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// BubbleActions value-imports the API barrel (getApiUrl → clientConfig),
// whose config module throws at import when VITE_API_BASE_URL is unset —
// same stub as MessageRow.test.tsx.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { BubbleActions } from './BubbleActions';
import { __resetSpeakerForTest } from '@desktop/features/voice/oneShotSpeakerBus';

interface FakeSource {
  onended: (() => void) | null;
  started: boolean;
  stopped: boolean;
  connect(): void;
  start(): void;
  stop(): void;
}

/** Every AudioContext playOneShot constructs, in creation order, with its one source. */
let ctxs: Array<{ sources: FakeSource[] }> = [];

function stubAudioContext(): void {
  ctxs = [];
  (window as unknown as { AudioContext: unknown }).AudioContext = vi.fn(() => {
    const sources: FakeSource[] = [];
    ctxs.push({ sources });
    return {
      decodeAudioData: vi.fn(async () => ({})),
      createBufferSource: (): FakeSource => {
        const s: FakeSource = {
          onended: null,
          started: false,
          stopped: false,
          connect() {},
          start() {
            this.started = true;
          },
          stop() {
            this.stopped = true;
          },
        };
        sources.push(s);
        return s;
      },
      destination: {},
      close: vi.fn(async () => {}),
    };
  });
}

interface FetchCall {
  url: string;
  body: { agentId?: string; text: string };
}

let fetchCalls: FetchCall[] = [];

function stubFetch(): void {
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({
        url,
        body: init?.body ? JSON.parse(init.body as string) : { text: '' },
      });
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response;
    })
  );
}

beforeEach(() => {
  __resetSpeakerForTest();
  stubAudioContext();
  stubFetch();
});

afterEach(() => {
  __resetSpeakerForTest();
  vi.unstubAllGlobals();
});

describe('BubbleActions — ▶ LISTEN re-listen button', () => {
  it('renders on both an agent message and a user message (no agentId)', () => {
    render(
      <>
        <div data-testid="row-a">
          <BubbleActions messageId="msg-a" content="hi from agent" agentId="agent-1" />
        </div>
        <div data-testid="row-b">
          <BubbleActions messageId="msg-b" content="hi from user" agentId={null} />
        </div>
      </>
    );

    expect(
      within(screen.getByTestId('row-a')).getByRole('button', { name: 'Listen' })
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('row-b')).getByRole('button', { name: 'Listen' })
    ).toBeInTheDocument();
  });

  it('click posts to /voice/speak-message with the agentId and plays the wav', async () => {
    render(<BubbleActions messageId="msg-a" content="hi from agent" agentId="agent-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Listen' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument());

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain('/voice/speak-message');
    expect(fetchCalls[0]!.body).toEqual({ agentId: 'agent-1', text: 'hi from agent' });
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0]!.sources[0]!.started).toBe(true);
  });

  it('omits agentId for a user message — server-side default voice', async () => {
    render(<BubbleActions messageId="msg-b" content="hi from user" agentId={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Listen' }));

    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0]!.body).toEqual({ text: 'hi from user' });
    expect('agentId' in fetchCalls[0]!.body).toBe(false);
  });

  it("a second message's click stops the first (single currently-speaking tracker)", async () => {
    render(
      <>
        <div data-testid="row-a">
          <BubbleActions messageId="msg-a" content="hi from agent" agentId="agent-1" />
        </div>
        <div data-testid="row-b">
          <BubbleActions messageId="msg-b" content="hi from user" agentId={null} />
        </div>
      </>
    );
    const rowA = screen.getByTestId('row-a');
    const rowB = screen.getByTestId('row-b');

    fireEvent.click(within(rowA).getByRole('button', { name: 'Listen' }));
    await waitFor(() =>
      expect(within(rowA).getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    );

    fireEvent.click(within(rowB).getByRole('button', { name: 'Listen' }));
    await waitFor(() =>
      expect(within(rowB).getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    );

    // A reverted to idle, and its clip was actually stopped (not just left
    // playing in the background).
    expect(within(rowA).getByRole('button', { name: 'Listen' })).toBeInTheDocument();
    expect(ctxs[0]!.sources[0]!.stopped).toBe(true);
    // B is the sole speaker now, and only two POSTs total were made — B's
    // claim did not trigger a redundant re-fetch of A.
    expect(fetchCalls).toHaveLength(2);
  });

  it('clicking the same button again stops it (toggle off, no re-fetch)', async () => {
    render(<BubbleActions messageId="msg-a" content="hi from agent" agentId="agent-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Listen' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Listen' })).toBeInTheDocument());

    expect(ctxs[0]!.sources[0]!.stopped).toBe(true);
    expect(fetchCalls).toHaveLength(1); // no second POST just to stop
  });

  it('works with no voice-session provider at all (voice mode fully off)', async () => {
    // Deliberately no VoiceSessionContext / useVoiceSession anywhere in this
    // tree — the re-listen button must not depend on a live voice session.
    render(<BubbleActions messageId="msg-a" content="works standalone" agentId={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Listen' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument());
    expect(fetchCalls).toHaveLength(1);
  });

  it('disables the button when the message has no text to speak', () => {
    render(<BubbleActions messageId="msg-empty" content="   " agentId={null} />);
    expect(screen.getByRole('button', { name: 'Listen' })).toBeDisabled();
  });
});

describe('BubbleActions — accessible names', () => {
  it('names each action in words, not by its glyph or shouted label', () => {
    render(<BubbleActions messageId="msg-a" content="hello" agentId={null} />);
    expect(screen.getByRole('button', { name: 'Copy message ID' })).toHaveTextContent('#ID');
    expect(screen.getByRole('button', { name: 'Copy message text' })).toHaveTextContent('COPY');
    expect(screen.getByRole('button', { name: 'Listen' })).toHaveTextContent('▶ LISTEN');
  });

  it('keeps the Listen name after a playback failure and describes the failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503 }) as Response)
    );
    render(<BubbleActions messageId="msg-a" content="hello" agentId={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Listen' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Listen' })).toHaveAttribute(
        'title',
        'Couldn’t play this message: speak failed (503)'
      )
    );
  });
});
