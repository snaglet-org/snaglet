import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultCursorSpec,
  generateColors,
  generateShape,
  type CursorSpec,
} from '@snaglet/shared/cursor';
import { workspaceColorTokens } from '@snaglet/shared/constants/workspaceTheme';

const list = vi.hoisted(() => vi.fn());
const ws = vi.hoisted(() => ({
  listeners: new Set<(m: unknown) => void>(),
  state: 'open' as 'open' | 'closed',
}));
vi.mock('@desktop/utils/api', async () => ({
  agentsApi: { list },
  getApiUrl: (p: string) => p,
}));
vi.mock('@desktop/ws/useWs', () => ({
  useWs: () => ({
    addMessageListener: (fn: (m: unknown) => void) => {
      ws.listeners.add(fn);
      return () => ws.listeners.delete(fn);
    },
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    connectionState: ws.state,
  }),
}));

import { resetAgentSpecCache } from '@desktop/components/agentCursor/useAgentSpecs';
import { AgentCursorOverlay } from './AgentCursorOverlay';
import { publishClarification, resetClarificationStore } from './clarificationStore';

const saved: CursorSpec = { v: 1, shape: generateShape(3), colors: generateColors(4) };

const send = (agentId: string, state: string, extra: Record<string, unknown> = {}) =>
  act(() => {
    for (const fn of ws.listeners)
      fn({
        type: 'agent:cursor',
        payload: {
          agentId,
          name: agentId,
          x: window.screenX + 100,
          y: window.screenY + 100,
          state,
          label: 'Working',
          flower: 'tulip',
          color: '#ef5d8a',
          holderAgentId: null,
          ...extra,
        },
      });
  });

beforeEach(() => {
  resetAgentSpecCache();
  list.mockResolvedValue([{ id: 'saved', cursorSpec: saved }]);
});
afterEach(() => document.documentElement.removeAttribute('style'));

describe('AgentCursorOverlay avatar', () => {
  it('renders the neutral FlowerAvatar at 80px', async () => {
    render(<AgentCursorOverlay />);
    send('plain', 'move');
    const img = screen.getByRole('img', { name: /flower avatar, neutral/i, hidden: true });
    expect(img).toHaveAttribute('width', '80');
    expect(img).toHaveAttribute('height', '80');
  });

  it('uses the saved spec when known and the default otherwise', async () => {
    render(<AgentCursorOverlay />);
    send('plain', 'move');
    const plain = screen.getByRole('img', { hidden: true }).innerHTML;
    expect(plain).toBeTruthy();
    send('saved', 'move');
    // Both cursors render, with different generated flowers.
    const imgs = await screen.findAllByRole('img', { hidden: true });
    expect(imgs).toHaveLength(2);
    expect(imgs[0].innerHTML).not.toBe(imgs[1].innerHTML);
    expect(defaultCursorSpec('plain')).not.toEqual(saved);
  });

  it('colors the click ring from the petal token', () => {
    expect(
      workspaceColorTokens.some((t) => t.name === defaultCursorSpec('ringer').colors.petal)
    ).toBe(true);
    list.mockResolvedValue([]);
    const spec = defaultCursorSpec('ringer');
    document.documentElement.style.setProperty(`--${spec.colors.petal}`, '#0a0b0c');
    render(<AgentCursorOverlay />);
    send('ringer', 'click');
    expect(screen.getByTestId('agent-cursor-ring').style.color).toBe('rgb(10, 11, 12)');
  });
});

describe('AgentCursorOverlay system overlay', () => {
  it('in-app overlay stands down on systemOverlay events', async () => {
    render(<AgentCursorOverlay />);
    send('a', 'move');
    expect(screen.getByTestId('agent-cursor-overlay')).toBeInTheDocument();
    send('a', 'move', { systemOverlay: true });
    expect(screen.queryByTestId('agent-cursor-overlay')).toBeNull();
    send('b', 'move', { systemOverlay: true });
    expect(screen.queryByTestId('agent-cursor-overlay')).toBeNull();
  });

  it('standalone draws at raw screen coordinates, with no pill', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}')))
    );
    render(<AgentCursorOverlay standalone />);
    send('a', 'move', { x: 321, y: 123, systemOverlay: true });
    const cursor = document.querySelector('.snaglet-agent-cursor') as HTMLElement;
    expect(cursor.style.transform).toBe('translate(321px, 123px)');
    expect(screen.queryByRole('status')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('standalone in a plain browser tab posts no heartbeat', () => {
    const fetchMock = vi.fn((..._a: unknown[]) => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    render(<AgentCursorOverlay standalone />);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('standalone posts the heartbeat on mount and every 4s', () => {
    vi.useFakeTimers();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 SnagletCursorOverlay');
    const fetchMock = vi.fn((..._a: unknown[]) => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<AgentCursorOverlay standalone />);
    const beats = () =>
      fetchMock.mock.calls.filter(([u]) => String(u).includes('/computer/overlay-heartbeat'));
    expect(beats()).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(8000));
    expect(beats()).toHaveLength(3);
    // A display change is reported at once, with the new size.
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(beats()).toHaveLength(4);
    expect(JSON.parse(String((beats()[3][1] as RequestInit).body))).toEqual({
      width: window.innerWidth,
      height: window.innerHeight,
    });
    unmount();
    act(() => void vi.advanceTimersByTime(8000));
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(beats()).toHaveLength(4);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('in-app overlay posts no heartbeat', () => {
    const fetchMock = vi.fn((..._a: unknown[]) => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    render(<AgentCursorOverlay />);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('AgentCursorOverlay reason text', () => {
  const tagText = (container: HTMLElement) =>
    container.querySelector('.snaglet-agent-cursor__tag span')?.textContent ?? '';

  it('never prints the agent name twice when the reason starts with it', async () => {
    const { container } = render(<AgentCursorOverlay />);
    for (const label of [
      'Bob: Projects hold threads',
      'bob — Projects hold threads',
      ' BOB - Projects hold threads',
    ]) {
      send('Bob', 'move', { label });
      expect(tagText(container).trim()).toBe('Projects hold threads');
      expect(
        container.querySelector('.snaglet-agent-cursor__tag')?.textContent?.match(/bob/gi)
      ).toHaveLength(1);
    }
  });

  it('keeps a reason that merely mentions the name or is only the name', async () => {
    const { container } = render(<AgentCursorOverlay />);
    send('Bob', 'move', { label: 'Bobbing along: checking files' });
    expect(tagText(container).trim()).toBe('Bobbing along: checking files');
    send('Bob', 'move', { label: 'Bob:' });
    expect(tagText(container).trim()).toBe('Bob:');
  });

  it('shows a long reason in full (it wraps, nothing is cut off)', async () => {
    const reason =
      'Opening the calendar to check Thursday afternoon for conflicts before I suggest a time. '
        .repeat(3)
        .trim();
    const { container } = render(<AgentCursorOverlay />);
    send('plain', 'move', { label: reason });
    expect(tagText(container).trim()).toBe(reason);
  });

  it('only cuts a reason that is absurdly long, and says so with an ellipsis', async () => {
    const { container } = render(<AgentCursorOverlay />);
    send('plain', 'move', { label: 'x'.repeat(2000) });
    const shown = tagText(container).trim();
    expect(shown.length).toBeLessThan(700);
    expect(shown.endsWith('…')).toBe(true);
  });

  it('opens the tag below the avatar when the flower is near the top of the screen', async () => {
    const { container } = render(<AgentCursorOverlay />);
    send('plain', 'move', { y: window.screenY + 20 });
    const tag = container.querySelector('.snaglet-agent-cursor__tag');
    expect(tag?.className).toContain('is-below');
  });

  it('keeps the tag above the avatar when there is room', async () => {
    const { container } = render(<AgentCursorOverlay />);
    send('plain', 'move', { y: window.screenY + 600 });
    const tag = container.querySelector('.snaglet-agent-cursor__tag');
    expect(tag?.className).not.toContain('is-below');
  });
});

describe('AgentCursorOverlay emotion', () => {
  afterEach(() => vi.useRealTimers());
  const face = () => screen.getByRole('img', { name: /flower avatar/i, hidden: true });

  it('shows stumped for a fresh error event and reverts to neutral after 3.5s', () => {
    vi.useFakeTimers();
    render(<AgentCursorOverlay />);
    send('err', 'idle', { emotion: 'stumped', label: 'input failed' });
    expect(face()).toHaveAttribute('aria-label', expect.stringMatching(/stumped/i));
    expect(screen.getByText(/input failed/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(face()).toHaveAttribute('aria-label', expect.stringMatching(/stumped/i));
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(face()).toHaveAttribute('aria-label', expect.stringMatching(/neutral/i));
  });

  it('stays neutral for events without an emotion', () => {
    render(<AgentCursorOverlay />);
    send('calm', 'idle');
    expect(face()).toHaveAttribute('aria-label', expect.stringMatching(/neutral/i));
  });

  it('keeps the emotion through a later idle event but a new move clears it', () => {
    render(<AgentCursorOverlay />);
    send('err', 'idle', { emotion: 'stumped' });
    send('err', 'idle');
    expect(face()).toHaveAttribute('aria-label', expect.stringMatching(/stumped/i));
    send('err', 'move');
    expect(face()).toHaveAttribute('aria-label', expect.stringMatching(/neutral/i));
  });

  it('thinking renewals keep the face past 3.5s, and it reverts once they stop', () => {
    vi.useFakeTimers();
    render(<AgentCursorOverlay />);
    for (let i = 0; i < 4; i++) {
      send('t', 'idle', { emotion: 'thinking', label: undefined });
      act(() => {
        vi.advanceTimersByTime(2500);
      });
    }
    expect(face()).toHaveAttribute('aria-label', expect.stringMatching(/thinking/i));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(face()).toHaveAttribute('aria-label', expect.stringMatching(/neutral/i));
  });

  it('curious renewals keep the question, an explicit neutral clears the face at once', () => {
    vi.useFakeTimers();
    render(<AgentCursorOverlay />);
    for (let i = 0; i < 3; i++) {
      send('q', 'idle', { emotion: 'curious', label: 'Which file?' });
      act(() => {
        vi.advanceTimersByTime(2500);
      });
    }
    expect(face()).toHaveAttribute('aria-label', expect.stringMatching(/curious/i));
    expect(screen.getByText(/Which file\?/)).toBeInTheDocument();
    send('q', 'idle', { emotion: 'neutral', label: undefined });
    expect(face()).toHaveAttribute('aria-label', expect.stringMatching(/neutral/i));
  });

  it('an emotion event without a label shows only the name, and a refresh draws no ring', () => {
    const { container } = render(<AgentCursorOverlay />);
    send('t', 'click', { label: 'Clicking the button' });
    expect(screen.getByTestId('agent-cursor-ring')).toBeInTheDocument();
    send('t', 'idle', { emotion: 'thinking', label: undefined });
    expect(container.querySelector('.snaglet-agent-cursor__tag span')).toBeNull();
    expect(screen.queryByText(/Clicking the button/)).toBeNull();
    expect(screen.queryByTestId('agent-cursor-ring')).toBeNull();
    expect(container.querySelector('.snaglet-agent-cursor__flower.is-click')).toBeNull();
  });
});

describe('angry, embarrassed and annoyed on the overlay', () => {
  it.each(['angry', 'embarrassed', 'annoyed'])(
    'draws the %s face from an emotion event',
    (emotion) => {
      render(<AgentCursorOverlay />);
      send('actor', 'idle', { emotion });
      expect(screen.getByRole('img', { name: /flower avatar/i, hidden: true })).toHaveAttribute(
        'aria-label',
        `flower avatar, ${emotion}`
      );
    }
  );
  it('angry shakes the avatar and annoyed rolls its eyes', () => {
    const { container, rerender } = render(<AgentCursorOverlay />);
    send('actor', 'idle', { emotion: 'angry' });
    const shake = container.querySelector('animateTransform[values^="-6 0"]');
    expect(shake).not.toBeNull();
    send('actor', 'idle', { emotion: 'annoyed' });
    expect(container.querySelector('[data-eye-roll="true"] animateTransform')).not.toBeNull();
    rerender(<AgentCursorOverlay />);
  });
  it('holds a still pose under reduced motion', () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      const { container } = render(<AgentCursorOverlay />);
      send('actor', 'idle', { emotion: 'angry' });
      expect(container.querySelectorAll('animateTransform')).toHaveLength(0);
      send('actor', 'idle', { emotion: 'annoyed' });
      expect(container.querySelectorAll('animateTransform')).toHaveLength(0);
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('avatar emotes', () => {
  it.each(['spin', 'hyper', 'laugh', 'cry', 'celebrate', 'angry'])(
    'renders and replays %s independently',
    (animation) => {
      const { container } = render(<AgentCursorOverlay />);
      send('other', 'move');
      send('actor', 'idle', { animation, animationId: 'one', emotion: 'happy' });
      const flower = container.querySelector(`[data-emote="${animation}"]`);
      expect(flower).toHaveClass(`emote-${animation}`);
      expect(container.querySelectorAll('[data-emote]')).toHaveLength(1);
      send('actor', 'idle', { animation, animationId: 'two', emotion: 'happy' });
      expect(container.querySelector(`[data-emote="${animation}"]`)).not.toBe(flower);
    }
  );
});

describe('reason text with special characters in the name', () => {
  it('strips a leading name that contains regex characters without breaking', () => {
    const { container } = render(<AgentCursorOverlay />);
    send('dr', 'move', { name: 'Dr. Bob (QA)', label: 'Dr. Bob (QA): checking the build' });
    expect(container.querySelector('.snaglet-agent-cursor__tag span')?.textContent?.trim()).toBe(
      'checking the build'
    );
  });
});

describe('getting a flower out of the way', () => {
  const fetchMock = vi.fn((..._a: unknown[]) => Promise.resolve(new Response('{}')));
  const posts = (path: string) =>
    fetchMock.mock.calls
      .filter(([u]) => String(u) === `/computer/cursor/${path}`)
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
  const grip = () => screen.getByTestId('agent-cursor-grip');
  const flower = () => document.querySelector('.snaglet-agent-cursor') as HTMLElement | null;
  const translate = (el: HTMLElement) =>
    (/translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform) ?? []).slice(1).map(Number);
  const settle = () => act(() => void vi.advanceTimersByTime(1000));
  const flowerSend = (payload: Record<string, unknown>) =>
    act(() => {
      for (const fn of ws.listeners) fn({ type: 'agent:cursor-flower', payload });
    });

  beforeEach(() => {
    vi.useFakeTimers();
    ws.state = 'open';
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    resetClarificationStore();
    // The Snaglet window has focus (jsdom reports none).
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetClarificationStore();
  });

  it('shows the × on hover only once the flower has been still for a second', () => {
    render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1', name: 'Ada' });
    fireEvent.mouseEnter(grip());
    expect(grip()).not.toHaveClass('is-live');
    act(() => void vi.advanceTimersByTime(999));
    expect(grip()).not.toHaveClass('is-live');
    settle();
    expect(grip()).toHaveClass('is-live', 'is-hover');
    expect(screen.getByRole('button', { name: "Hide Ada's cursor" })).toBeInTheDocument();
  });

  it('the × hides that flower and tells the server; the agent keeps its pill and Esc', () => {
    render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1', name: 'Ada' });
    settle();
    fireEvent.mouseEnter(grip());
    fireEvent.click(screen.getByRole('button', { name: "Hide Ada's cursor" }), { detail: 1 });
    expect(flower()).toBeNull();
    expect(posts('dismiss')).toMatchObject([{ agentId: 'ada', session: 's1' }]);
    expect(posts('dismiss')[0].pointer).toEqual(expect.objectContaining({ x: expect.any(Number) }));
    expect(screen.getByRole('status')).toHaveTextContent(/Esc to stop/);
    // Later events of the same session keep it hidden; a new session shows it again.
    send('ada', 'move', { session: 's1', x: window.screenX + 300 });
    expect(flower()).toBeNull();
    send('ada', 'move', { session: 's2' });
    expect(flower()).not.toBeNull();
  });

  it('a mouse click on the × does nothing while the flower is still moving', () => {
    render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1', name: 'Ada' });
    fireEvent.click(screen.getByRole('button', { name: "Hide Ada's cursor" }), { detail: 1 });
    expect(flower()).not.toBeNull();
    expect(posts('dismiss')).toEqual([]);
  });

  it('a new event makes the flower click-through at once', () => {
    render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1' });
    settle();
    expect(grip()).toHaveClass('is-live');
    send('ada', 'click', { session: 's1' });
    expect(grip()).not.toHaveClass('is-live');
    // A flower left in the click state (the agent's last action) can still be moved away.
    settle();
    expect(grip()).toHaveClass('is-live');
  });

  it("another agent's action makes every flower click-through until all are still", () => {
    render(<AgentCursorOverlay />);
    send('venus', 'idle', { session: 'v1', x: window.screenX + 500, y: window.screenY + 300 });
    settle();
    const gripOf = (id: string) =>
      document.querySelector(`[data-flower-grip="${id}"]`) as HTMLElement;
    expect(gripOf('venus')).toHaveClass('is-live');
    send('bob', 'move', { session: 'b1', x: window.screenX + 100, y: window.screenY + 100 });
    expect(gripOf('venus')).not.toHaveClass('is-live');
    act(() => void vi.advanceTimersByTime(999));
    expect(gripOf('venus')).not.toHaveClass('is-live');
    act(() => void vi.advanceTimersByTime(1));
    expect(gripOf('venus')).toHaveClass('is-live');
    expect(gripOf('bob')).toHaveClass('is-live');
  });

  it('in the app window, a flower takes the mouse only while Snaglet has focus', () => {
    const focus = vi.mocked(document.hasFocus).mockReturnValue(false);
    render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1' });
    settle();
    expect(grip()).not.toHaveClass('is-live');
    const [x0, y0] = translate(flower() as HTMLElement);
    fireEvent.mouseDown(grip(), { button: 0, clientX: x0 - 30, clientY: y0 - 30 });
    expect(posts('grab')).toEqual([]);
    focus.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(grip()).toHaveClass('is-live');
  });

  it('a press tells the server at once, before it becomes a drag', () => {
    render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1' });
    settle();
    const [x0, y0] = translate(flower() as HTMLElement);
    fireEvent.mouseDown(grip(), { button: 0, clientX: x0 - 30, clientY: y0 - 30 });
    expect(posts('grab')).toEqual([{ agentId: 'ada', session: 's1', held: true }]);
    fireEvent.mouseUp(window, { clientX: x0 - 30, clientY: y0 - 30 });
    expect(posts('grab')).toEqual([
      { agentId: 'ada', session: 's1', held: true },
      { agentId: 'ada', session: 's1', held: false },
    ]);
  });

  it('keeps every flower held after a reconnect until the resync succeeds, retrying', async () => {
    let failures = 1;
    fetchMock.mockImplementation((url: unknown) => {
      if (String(url) !== '/computer/cursor/flowers') return Promise.resolve(new Response('{}'));
      if (failures-- > 0) return Promise.reject(new Error('offline'));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            flowers: [
              {
                agentId: 'ada',
                session: 's1',
                dismissed: false,
                parkedAt: null,
                systemOverlay: false,
              },
            ],
          })
        )
      );
    });
    const { rerender } = render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1' });
    settle();
    ws.state = 'closed';
    rerender(<AgentCursorOverlay />);
    ws.state = 'open';
    rerender(<AgentCursorOverlay />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => void vi.advanceTimersByTime(1500));
    expect(grip()).not.toHaveClass('is-live');
    // The retry succeeds; the flowers settle again from then.
    act(() => void vi.advanceTimersByTime(1000));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(grip()).not.toHaveClass('is-live');
    settle();
    expect(grip()).toHaveClass('is-live');
    expect(
      fetchMock.mock.calls.filter(([u]) => String(u) === '/computer/cursor/flowers')
    ).toHaveLength(2);
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}')));
  });

  it('a resync cut off by another disconnect does not hold the flowers forever', async () => {
    fetchMock.mockImplementation((url: unknown) =>
      String(url) === '/computer/cursor/flowers'
        ? new Promise<Response>(() => undefined)
        : Promise.resolve(new Response('{}'))
    );
    const { rerender } = render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1' });
    settle();
    ws.state = 'closed';
    rerender(<AgentCursorOverlay />);
    ws.state = 'open';
    rerender(<AgentCursorOverlay />);
    // The read never answers; the connection drops again and Ada's flower goes meanwhile.
    ws.state = 'closed';
    rerender(<AgentCursorOverlay />);
    send('ada', 'hidden', { session: 's1' });
    ws.state = 'open';
    rerender(<AgentCursorOverlay />);
    send('bob', 'move', { session: 'b1' });
    settle();
    expect(grip()).toHaveClass('is-live');
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}')));
  });

  it('resyncs hides and parks after the connection comes back, and settles again', async () => {
    fetchMock.mockImplementation((url: unknown) =>
      Promise.resolve(
        new Response(
          String(url) === '/computer/cursor/flowers'
            ? JSON.stringify({
                flowers: [
                  {
                    agentId: 'ada',
                    session: 's1',
                    dismissed: false,
                    parkedAt: { x: 42, y: 43 },
                    systemOverlay: false,
                  },
                ],
              })
            : '{}'
        )
      )
    );
    const ada = () => document.querySelector('[data-flower-grip="ada"]') as HTMLElement;
    const adaFlower = () => ada().parentElement as HTMLElement;
    const { rerender } = render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1' });
    send('bob', 'move', { session: 'b1' });
    settle();
    ws.state = 'closed';
    rerender(<AgentCursorOverlay />);
    expect(ada()).not.toHaveClass('is-live');
    ws.state = 'open';
    rerender(<AgentCursorOverlay />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Bob's session ended while the socket was down; Ada was parked from another overlay.
    expect(document.querySelector('[data-flower-grip="bob"]')).toBeNull();
    expect(translate(adaFlower())).toEqual([
      42 - window.screenX,
      43 - window.screenY - (window.outerHeight - window.innerHeight),
    ]);
    expect(ada()).not.toHaveClass('is-live');
    settle();
    expect(ada()).toHaveClass('is-live');
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}')));
  });

  it('an emotion refresh does not take the mouse away', () => {
    render(<AgentCursorOverlay />);
    send('ada', 'idle', { session: 's1' });
    settle();
    send('ada', 'idle', { session: 's1', emotion: 'thinking', emotionUpdate: 'renew' });
    expect(grip()).toHaveClass('is-live');
  });

  it('no flower takes the mouse without a live connection', () => {
    ws.state = 'closed';
    render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1' });
    act(() => void vi.advanceTimersByTime(5000));
    expect(grip()).not.toHaveClass('is-live');
  });

  it('dragging parks the flower where it is dropped, and it stops following the pointer', () => {
    render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1' });
    settle();
    const [x0, y0] = translate(flower() as HTMLElement);
    fireEvent.mouseDown(grip(), { button: 0, clientX: x0 - 30, clientY: y0 - 30 });
    fireEvent.mouseMove(window, { clientX: x0 + 20, clientY: y0 + 10 });
    expect(posts('grab')).toEqual([{ agentId: 'ada', session: 's1', held: true }]);
    expect(translate(flower() as HTMLElement)).toEqual([x0 + 50, y0 + 40]);
    fireEvent.mouseUp(window, { clientX: x0 + 20, clientY: y0 + 10 });
    const chrome = window.outerHeight - window.innerHeight;
    expect(posts('park')).toEqual([
      {
        agentId: 'ada',
        session: 's1',
        x: x0 + 50 + window.screenX,
        y: y0 + 40 + window.screenY + chrome,
        pointer: { x: x0 + 20 + window.screenX, y: y0 + 10 + window.screenY + chrome },
      },
    ]);
    send('ada', 'move', { session: 's1', x: window.screenX + 400, y: window.screenY + 400 });
    expect(translate(flower() as HTMLElement)).toEqual([x0 + 50, y0 + 40]);
  });

  it('a short press is not a drag, and a press ends with the next action', () => {
    render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1' });
    settle();
    const [x0, y0] = translate(flower() as HTMLElement);
    fireEvent.mouseDown(grip(), { button: 0, clientX: x0 - 30, clientY: y0 - 30 });
    fireEvent.mouseMove(window, { clientX: x0 - 28, clientY: y0 - 29 });
    send('ada', 'move', { session: 's1', x: window.screenX + 300 });
    fireEvent.mouseMove(window, { clientX: x0 + 50, clientY: y0 + 50 });
    fireEvent.mouseUp(window, { clientX: x0 + 50, clientY: y0 + 50 });
    // The press was announced and then let go; it never became a drag.
    expect(posts('grab').map((b) => b.held)).toEqual([true, false]);
    expect(posts('park')).toEqual([]);
  });

  it('dropping it mostly off the window edge hides it, like the ×', () => {
    render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1' });
    settle();
    const [x0, y0] = translate(flower() as HTMLElement);
    fireEvent.mouseDown(grip(), { button: 0, clientX: x0 - 30, clientY: y0 - 30 });
    fireEvent.mouseMove(window, { clientX: -100, clientY: y0 - 30 });
    fireEvent.mouseUp(window, { clientX: -100, clientY: y0 - 30 });
    expect(flower()).toBeNull();
    expect(posts('dismiss')).toMatchObject([{ agentId: 'ada', session: 's1' }]);
    expect(posts('park')).toEqual([]);
  });

  it('applies a hide or park made in another overlay', () => {
    render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1' });
    flowerSend({ agentId: 'ada', session: 's1', dismissed: false, parkedAt: { x: 42, y: 43 } });
    expect(translate(flower() as HTMLElement)).toEqual([
      42 - window.screenX,
      43 - window.screenY - (window.outerHeight - window.innerHeight),
    ]);
    flowerSend({ agentId: 'ada', session: 'old', dismissed: true, parkedAt: null });
    expect(flower()).not.toBeNull();
    flowerSend({ agentId: 'ada', session: 's1', dismissed: true, parkedAt: null });
    expect(flower()).toBeNull();
  });

  it("a hidden flower's question stays on screen, in the corner", () => {
    render(<AgentCursorOverlay />);
    send('ada', 'move', { session: 's1', dismissed: true });
    act(() => {
      publishClarification({
        request: {
          threadId: 'thread-1',
          callId: 'call-1',
          agentId: 'ada',
          request: { questions: [{ id: 'q1', prompt: 'Send it?', type: 'text' }] },
        } as never,
        respond: vi.fn(),
      });
    });
    expect(flower()).toBeNull();
    expect(screen.getByTestId('agent-ask-card')).toBeInTheDocument();
  });
});

describe('standalone flower input from the native overlay', () => {
  type FlowerWindow = {
    __snagletCursorFlowers?: () => string;
    __snagletCursorFlowerInput?: (i: Record<string, unknown>) => void;
  };
  const w = window as unknown as FlowerWindow;
  const fetchMock = vi.fn((..._a: unknown[]) => Promise.resolve(new Response('{}')));
  const posts = (path: string) =>
    fetchMock.mock.calls.filter(([u]) => String(u) === `/computer/cursor/${path}`).length;
  const rect = (x: number, y: number, width: number, height: number) =>
    ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height }) as DOMRect;

  beforeEach(() => {
    vi.useFakeTimers();
    ws.state = 'open';
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    // jsdom has no layout: give the grip and the × the rects the real page would.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.dataset.flowerClose) return rect(318, 238, 20, 20);
      if (this.dataset.flowerGrip) return rect(238, 238, 80, 54);
      return rect(0, 0, 0, 0);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const report = () => JSON.parse(w.__snagletCursorFlowers?.() ?? 'null').flowers;
  const input = (kind: string, x: number, y: number) =>
    act(() => w.__snagletCursorFlowerInput?.({ kind, agentId: 'ada', x, y }));
  const grabs = () =>
    fetchMock.mock.calls
      .filter(([u]) => String(u) === '/computer/cursor/grab')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)).held);

  it('reports each grip and whether it takes the mouse yet', () => {
    const { unmount } = render(<AgentCursorOverlay standalone />);
    send('ada', 'move', { session: 's1', x: 300, y: 300, systemOverlay: true });
    expect(report()).toEqual([{ id: 'ada', x: 238, y: 238, w: 80, h: 54, live: false }]);
    act(() => void vi.advanceTimersByTime(1000));
    expect(report()[0].live).toBe(true);
    send('ada', 'move', { session: 's1', x: 300, y: 300, systemOverlay: true });
    expect(report()[0].live).toBe(false);
    unmount();
    expect(w.__snagletCursorFlowers).toBeUndefined();
    expect(w.__snagletCursorFlowerInput).toBeUndefined();
  });

  it('a click on the visible × hides the flower', () => {
    render(<AgentCursorOverlay standalone />);
    send('ada', 'move', { session: 's1', x: 300, y: 300, systemOverlay: true });
    act(() => void vi.advanceTimersByTime(1000));
    act(() => w.__snagletCursorFlowerInput?.({ kind: 'hover', agentId: 'ada', x: 300, y: 260 }));
    expect(screen.getByTestId('agent-cursor-grip')).toHaveClass('is-hover');
    act(() => w.__snagletCursorFlowerInput?.({ kind: 'down', agentId: 'ada', x: 328, y: 248 }));
    act(() => w.__snagletCursorFlowerInput?.({ kind: 'up', agentId: 'ada', x: 328, y: 248 }));
    expect(posts('dismiss')).toBe(1);
    expect(document.querySelector('.snaglet-agent-cursor')).toBeNull();
  });

  it('a drag through the native panel parks the flower in screen points', () => {
    render(<AgentCursorOverlay standalone />);
    send('ada', 'move', { session: 's1', x: 300, y: 300, systemOverlay: true });
    act(() => void vi.advanceTimersByTime(1000));
    act(() => w.__snagletCursorFlowerInput?.({ kind: 'down', agentId: 'ada', x: 270, y: 260 }));
    act(() => w.__snagletCursorFlowerInput?.({ kind: 'move', agentId: 'ada', x: 470, y: 160 }));
    expect(report()[0].live).toBe(true);
    act(() => w.__snagletCursorFlowerInput?.({ kind: 'up', agentId: 'ada', x: 470, y: 160 }));
    const park = fetchMock.mock.calls.find(([u]) => String(u) === '/computer/cursor/park');
    expect(JSON.parse(String((park?.[1] as RequestInit).body))).toEqual({
      agentId: 'ada',
      session: 's1',
      x: 500,
      y: 200,
      pointer: { x: 470, y: 160 },
    });
    const cursor = document.querySelector('.snaglet-agent-cursor') as HTMLElement;
    expect(cursor.style.transform).toBe('translate(500px, 200px)');
  });

  it('reports only the grips: the native side orders and ages replies by its own clock', () => {
    render(<AgentCursorOverlay standalone />);
    send('ada', 'move', { session: 's1', x: 300, y: 300, systemOverlay: true });
    expect(Object.keys(JSON.parse(w.__snagletCursorFlowers?.() ?? '{}'))).toEqual(['flowers']);
  });

  it('a drag with no news from the mouse for a second stops taking the mouse', () => {
    render(<AgentCursorOverlay standalone />);
    send('ada', 'move', { session: 's1', x: 300, y: 300, systemOverlay: true });
    act(() => void vi.advanceTimersByTime(1000));
    input('down', 270, 260);
    input('move', 470, 160);
    expect(report()[0].live).toBe(true);
    act(() => void vi.advanceTimersByTime(1100));
    expect(report()[0].live).toBe(false);
    input('move', 471, 161);
    expect(report()[0].live).toBe(true);
  });

  it('the native side can cancel a drag it lost; the flower goes back and the grab is released', () => {
    render(<AgentCursorOverlay standalone />);
    send('ada', 'move', { session: 's1', x: 300, y: 300, systemOverlay: true });
    act(() => void vi.advanceTimersByTime(1000));
    input('down', 270, 260);
    input('move', 470, 160);
    input('cancel', 470, 160);
    expect(grabs()).toEqual([true, false]);
    expect(posts('park')).toBe(0);
    const cursor = document.querySelector('.snaglet-agent-cursor') as HTMLElement;
    expect(cursor.style.transform).toBe('translate(300px, 300px)');
  });

  it('a long drag renews its grab while the mouse keeps reporting', () => {
    render(<AgentCursorOverlay standalone />);
    send('ada', 'move', { session: 's1', x: 300, y: 300, systemOverlay: true });
    act(() => void vi.advanceTimersByTime(1000));
    input('down', 270, 260);
    for (let i = 0; i < 70; i++) {
      act(() => void vi.advanceTimersByTime(100));
      input('move', 300 + i, 200);
    }
    expect(grabs().filter((h) => h === true).length).toBeGreaterThanOrEqual(3);
  });

  it('ignores the mouse on a flower that is still moving', () => {
    render(<AgentCursorOverlay standalone />);
    send('ada', 'move', { session: 's1', x: 300, y: 300, systemOverlay: true });
    act(() => w.__snagletCursorFlowerInput?.({ kind: 'down', agentId: 'ada', x: 270, y: 260 }));
    act(() => w.__snagletCursorFlowerInput?.({ kind: 'move', agentId: 'ada', x: 470, y: 160 }));
    act(() => w.__snagletCursorFlowerInput?.({ kind: 'up', agentId: 'ada', x: 470, y: 160 }));
    expect(posts('grab') + posts('park') + posts('dismiss')).toBe(0);
  });
});
