/**
 * useChatSocketSession + WebSocketProvider: channel-subscription lifecycle.
 * With the same thread open in two panes, closing one must not unsubscribe
 * the other: the registry is holder-counted and sends the wire `unsubscribe`
 * only when the last holder releases.
 *
 * Runs the real WebSocketProvider against a fake socket whose server half
 * mirrors WebSocketService: `subscribe`/`unsubscribe` frames change a
 * per-connection channel set, and broadcasts only reach subscribed channels.
 */
import { useEffect, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsMessage } from '@snaglet/shared/types';
import { WebSocketProvider } from '@desktop/ws/WebSocketContext';
import { useWs, useWsChannel } from '@desktop/ws/useWs';
import { useChatSocketSession } from './useChatSocketSession';

/** Server half — the exact contract of WebSocketService for one connection. */
class FakeServer {
  /** Mirror of ManagedClient.channels for the live connection. */
  channels = new Set<string>();
  /** Every frame the client sent, in order. */
  received: WsMessage[] = [];
  socket: FakeWebSocket | null = null;

  onConnect(socket: FakeWebSocket): void {
    this.socket = socket;
    // A new connection is a fresh ManagedClient — no channels survive it.
    this.channels.clear();
  }

  handleFrame(raw: string): void {
    const msg = JSON.parse(raw) as WsMessage;
    this.received.push(msg);
    // Mirrors WebSocketService.handleMessage's built-in subscribe handling.
    if (msg.type === 'subscribe' && msg.channel) this.channels.add(msg.channel);
    if (msg.type === 'unsubscribe' && msg.channel) this.channels.delete(msg.channel);
  }

  /**
   * Mirrors WebSocketService.broadcastToChannel: the frame reaches the client
   * only when its channel set contains the channel. Returns whether it was
   * delivered so a test can assert the miss directly.
   */
  broadcastToChannel(channel: string, message: WsMessage): boolean {
    if (!this.channels.has(channel)) return false;
    this.socket?.receive({ ...message, channel });
    return true;
  }
}

let server: FakeServer;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    server.onConnect(this);
  }

  send(data: string): void {
    server.handleFrame(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  /** Test hook: complete the handshake. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Test hook: server → client frame. */
  receive(message: WsMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

/**
 * One chat pane: the real subscription hook plus a frame listener with the
 * same scope guard useChatStream's listener applies before painting.
 */
function ThreadPane({
  threadId,
  painted,
  participantCount = 1,
  refetchParticipants,
}: {
  threadId: string;
  painted: WsMessage[];
  participantCount?: number;
  refetchParticipants?: () => void;
}) {
  const { addMessageListener } = useWs();
  useChatSocketSession(threadId, participantCount, refetchParticipants);
  useEffect(
    () =>
      addMessageListener((msg) => {
        if (msg.channel != null && msg.channel !== threadId) return;
        if (msg.type === 'socket:chat:message_created') painted.push(msg);
      }),
    [addMessageListener, threadId, painted]
  );
  return null;
}

function Providers({ children }: { children?: ReactNode }) {
  return <WebSocketProvider>{children ?? null}</WebSocketProvider>;
}

/** The exact broadcast threadEvents.persistAndBroadcast emits on a toggle. */
function threadEventFrame(
  threadId: string,
  content = '[voice mode enabled · your replies are spoken automatically]'
): WsMessage {
  return {
    type: 'socket:chat:message_created',
    payload: {
      id: 'evt-1',
      threadId,
      role: 'user',
      content,
      created_at: '2026-08-12T00:00:00.000Z',
      message_type: 'thread_event',
    },
  };
}

beforeEach(() => {
  server = new FakeServer();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useChatSocketSession — channel subscription lifecycle', () => {
  it('still delivers a live thread_event after a second pane on the same thread closes', () => {
    const paintedA: WsMessage[] = [];
    const paintedB: WsMessage[] = [];
    const view = render(
      <Providers>
        <ThreadPane threadId="t1" painted={paintedA} />
        <ThreadPane threadId="t1" painted={paintedB} />
      </Providers>
    );
    act(() => server.socket!.open());
    expect(server.channels.has('t1')).toBe(true);

    // Close the second pane; the first still views the thread.
    view.rerender(
      <Providers>
        <ThreadPane threadId="t1" painted={paintedA} />
      </Providers>
    );

    // A voice/vision toggle fires server-side → persistAndBroadcast.
    let delivered = false;
    act(() => {
      delivered = server.broadcastToChannel('t1', threadEventFrame('t1'));
    });

    // Pre-fix: pane B's cleanup unsubscribed the shared channel, the server
    // dropped it, and the surviving pane never received the frame (it only
    // showed up after a reload re-hydrated history over REST).
    expect(delivered).toBe(true);
    expect(paintedA).toHaveLength(1);
  });

  it('releases the channel only when the last viewer closes', () => {
    const paintedA: WsMessage[] = [];
    const paintedB: WsMessage[] = [];
    const view = render(
      <Providers>
        <ThreadPane threadId="t1" painted={paintedA} />
        <ThreadPane threadId="t1" painted={paintedB} />
      </Providers>
    );
    act(() => server.socket!.open());
    expect(server.channels.has('t1')).toBe(true);

    view.rerender(
      <Providers>
        <ThreadPane threadId="t1" painted={paintedA} />
      </Providers>
    );
    expect(server.channels.has('t1')).toBe(true);

    // Last viewer gone: the subscription must actually be released — a
    // holder-count leak here would keep dead channels subscribed forever.
    view.rerender(<Providers />);
    expect(server.channels.has('t1')).toBe(false);
  });

  it('joins the channel once the connection opens when the pane mounted while still connecting', () => {
    const painted: WsMessage[] = [];
    render(
      <Providers>
        <ThreadPane threadId="t1" painted={painted} />
      </Providers>
    );

    // Handshake not complete — the subscribe frame cannot have been sent yet.
    expect(server.channels.has('t1')).toBe(false);

    // On open, resubscribeChannels() reconciles the registry to the server,
    // so a toggle fired immediately after connect paints live.
    act(() => server.socket!.open());
    expect(server.channels.has('t1')).toBe(true);

    let delivered = false;
    act(() => {
      delivered = server.broadcastToChannel('t1', threadEventFrame('t1'));
    });
    expect(delivered).toBe(true);
    expect(painted).toHaveLength(1);
  });

  it('restores the channel after a reconnect (fresh server-side client state)', () => {
    vi.useFakeTimers();
    const painted: WsMessage[] = [];
    render(
      <Providers>
        <ThreadPane threadId="t1" painted={painted} />
      </Providers>
    );
    const first = server.socket!;
    act(() => first.open());
    expect(server.channels.has('t1')).toBe(true);

    // Connection drops; the reconnect timer runs (base 1s + jitter ≤ 0.5s).
    act(() => first.close());
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    const reconnected = server.socket!;
    expect(reconnected).not.toBe(first);
    expect(server.channels.has('t1')).toBe(false);

    act(() => reconnected.open());
    expect(server.channels.has('t1')).toBe(true);

    let delivered = false;
    act(() => {
      delivered = server.broadcastToChannel('t1', threadEventFrame('t1'));
    });
    expect(delivered).toBe(true);
    expect(painted).toHaveLength(1);
  });

  it('refetches participants when a participant-added thread event arrives', () => {
    const painted: WsMessage[] = [];
    const refetchParticipants = vi.fn();
    render(
      <Providers>
        <ThreadPane threadId="t1" painted={painted} refetchParticipants={refetchParticipants} />
      </Providers>
    );
    act(() => server.socket!.open());

    act(() => {
      server.broadcastToChannel(
        't1',
        threadEventFrame('t1', '[participant added · Ada joined the thread]')
      );
    });

    expect(refetchParticipants).toHaveBeenCalledOnce();
  });
});

describe('WebSocketProvider — incoming frames', () => {
  it('reach listeners without re-rendering every useWs consumer', () => {
    let consumerRenders = 0;
    function Consumer() {
      useWs();
      consumerRenders += 1;
      return null;
    }
    const channelSnapshots: WsMessage[][] = [];
    function ChannelConsumer() {
      const { messages } = useWsChannel('t1');
      channelSnapshots.push(messages);
      return null;
    }
    render(
      <Providers>
        <Consumer />
        <ChannelConsumer />
      </Providers>
    );
    act(() => server.socket!.open());
    const rendersWhenOpen = consumerRenders;

    // A burst of streaming deltas, delivered within one batch.
    act(() => {
      for (let i = 0; i < 20; i += 1) {
        server.broadcastToChannel('t1', { type: 'socket:delta', payload: { text: `chunk ${i}` } });
      }
    });

    expect(consumerRenders).toBe(rendersWhenOpen);
    // The channel hook still sees every frame, none lost to batching.
    expect(channelSnapshots[channelSnapshots.length - 1]).toHaveLength(20);
  });
});
