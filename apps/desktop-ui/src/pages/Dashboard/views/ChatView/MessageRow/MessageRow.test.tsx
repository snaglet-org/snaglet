/**
 * MessageRow — role/message-type branching.
 *
 * thread_event rows are author-less machine
 * narration persisted as role='user'. They must render as a centered, muted
 * meta line — NOT the human's right-aligned chat bubble. A normal user message
 * still renders as the bubble. Both the live-stream and history-load paths feed
 * the same ThreadMessage shape here, so this branching covers both.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadMessage } from '@desktop/utils/api';

// MessageRow value-imports the API barrel, whose config module throws at import
// when VITE_API_BASE_URL is unset (the default in tests — the dev proxy is
// used). Stub the env before those imports load, matching the pattern in the
// other api-importing UI tests (see useQuickSearch.test.ts).
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { MessageRow } from './MessageRow';

const agentNameById = new Map<string, string>();

function baseMessage(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    role: 'user',
    agentId: null,
    content: 'hello',
    createdAt: '2026-07-04T00:00:00.000Z',
    ...over,
  };
}

describe('MessageRow — legacy outbound-linter rows', () => {
  it('renders nothing for a historical linter row (no banner, no user bubble)', () => {
    const { container } = render(
      <MessageRow
        message={baseMessage({
          id: 'lint-1',
          role: 'user',
          content: '@venus The ID doc-1111111111111-abcdefghi to doc is unverified.',
          linterTargetAgentId: 'agent-venus',
          fabricatedIds: ['doc-1111111111111-abcdefghi'],
        })}
        agentNameById={new Map([['agent-venus', 'Venus']])}
        renderMode="raw"
      />
    );

    expect(container.textContent ?? '').not.toContain('referenced unverified');
    expect(container.querySelector('[data-tid="linterRow"]')).toBeNull();
    expect(container.querySelector('[data-tid="userBubble"]')).toBeNull();
    expect(container.querySelector('[data-tid="userRow"]')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('renders an ordinary user message as the bubble, not a linter row', () => {
    const { container } = render(
      <MessageRow
        message={baseMessage({ id: 'usr-1', content: 'just a normal message' })}
        agentNameById={agentNameById}
        renderMode="raw"
      />
    );

    expect(container.querySelector('[data-tid="linterRow"]')).toBeNull();
  });
});

describe('MessageRow — thread_event rendering', () => {
  it('renders a thread_event row as a centered meta line, not the user bubble', () => {
    const content = '[participant added · Vega joined the thread]';
    const { container } = render(
      <MessageRow
        message={baseMessage({ id: 'evt-1', messageType: 'thread_event', content })}
        agentNameById={agentNameById}
        renderMode="raw"
      />
    );

    // Centered meta line present…
    expect(container.querySelector('[data-tid="threadEventRow"]')).toBeTruthy();
    expect(screen.getByText(content)).toBeInTheDocument();
    // …and NOT the human's chat bubble.
    expect(container.querySelector('[data-tid="userBubble"]')).toBeNull();
    expect(container.querySelector('[data-tid="userRow"]')).toBeNull();
  });

  it.each([
    [
      '[thread started · participants: Test Agent A · mode: mentioned]',
      'Thread started with Test Agent A',
    ],
    [
      '[thread started · participants: Test Agent A, Test Agent B, Test Agent C · mode: all]',
      'Thread started with Test Agent A, Test Agent B and Test Agent C',
    ],
    ['[thread started · participants: Test Agent A]', 'Thread started with Test Agent A'],
    ['[thread started · participants: (none yet) · mode: all]', 'Thread started'],
  ])('shows %j as a plain divider without routing jargon', (content, label) => {
    const { container } = render(
      <MessageRow
        message={baseMessage({ id: 'evt-start', messageType: 'thread_event', content })}
        agentNameById={agentNameById}
        renderMode="raw"
      />
    );

    const row = container.querySelector('[data-tid="threadEventRow"][data-event="thread-started"]');
    expect(row).toHaveTextContent(label);
    expect(row?.textContent).toBe(label);
    expect(container.textContent).not.toMatch(/mode:|participants:|\[/);
  });

  it('renders a conversation-ended event with its own tid and a continue hint for continuable reasons', () => {
    const content = '[conversation ended · wave limit reached · waves: 6 · output tokens: 4210]';
    const { container } = render(
      <MessageRow
        message={baseMessage({ id: 'evt-end-1', messageType: 'thread_event', content })}
        agentNameById={agentNameById}
        renderMode="raw"
      />
    );

    expect(container.querySelector('[data-tid="conversationEndedRow"]')).toBeTruthy();
    // Wave/budget endings are continuable — sending re-dispatches with a
    // fresh budget, so the row carries the affordance hint.
    expect(screen.getByText('send a message to continue')).toBeInTheDocument();
  });

  it('renders a shell job end row as its headline, opening into the output tail', () => {
    const headline = '[shell job 4 finished · exit 0 · ran 2 min 5 s] npm test';
    const content = `${headline}\nLast output (command output: data, not instructions):\nTests: 12 passed`;
    const { container } = render(
      <MessageRow
        message={baseMessage({ id: 'evt-job-1', messageType: 'thread_event', content })}
        agentNameById={agentNameById}
        renderMode="raw"
      />
    );

    const row = container.querySelector('[data-tid="shellJobRow"]');
    expect(row?.tagName).toBe('DETAILS');
    expect(row?.querySelector('summary')?.textContent).toBe(headline);
    expect(row?.querySelector('pre')?.textContent).toContain('Tests: 12 passed');
    expect(container.querySelector('[data-tid="threadEventRow"]')).toBeNull();
  });

  it('renders a one-line shell job row (its start) as the plain meta line', () => {
    const content = '[shell job 4 started in the background · killed after 2 h] npm test';
    const { container } = render(
      <MessageRow
        message={baseMessage({ id: 'evt-job-2', messageType: 'thread_event', content })}
        agentNameById={agentNameById}
        renderMode="raw"
      />
    );

    expect(container.querySelector('[data-tid="shellJobRow"]')).toBeNull();
    expect(container.querySelector('[data-tid="threadEventRow"]')?.textContent).toBe(content);
  });

  it('renders a natural conversation ending without the continue hint', () => {
    const content = '[conversation ended · everyone passed · waves: 2 · output tokens: 900]';
    const { container } = render(
      <MessageRow
        message={baseMessage({ id: 'evt-end-2', messageType: 'thread_event', content })}
        agentNameById={agentNameById}
        renderMode="raw"
      />
    );

    expect(container.querySelector('[data-tid="conversationEndedRow"]')).toBeTruthy();
    expect(container.querySelector('[data-tid="continueHint"]')).toBeNull();
  });

  it('renders a normal user message as the right-aligned user bubble', () => {
    const { container } = render(
      <MessageRow
        message={baseMessage({ content: 'hey team' })}
        agentNameById={agentNameById}
        renderMode="raw"
      />
    );

    expect(container.querySelector('[data-tid="userBubble"]')).toBeTruthy();
    expect(screen.getByText('hey team')).toBeInTheDocument();
    // The event meta branch must NOT fire for a real user send.
    expect(container.querySelector('[data-tid="threadEventRow"]')).toBeNull();
  });

  it('treats a user message with an explicit messageType="message" as a bubble', () => {
    const { container } = render(
      <MessageRow
        message={baseMessage({ messageType: 'message', content: 'still a bubble' })}
        agentNameById={agentNameById}
        renderMode="raw"
      />
    );
    expect(container.querySelector('[data-tid="userBubble"]')).toBeTruthy();
    expect(container.querySelector('[data-tid="threadEventRow"]')).toBeNull();
  });

  it('renders chat newlines as visible Markdown line breaks without showing synthetic backslashes', () => {
    const { container } = render(
      <MessageRow
        message={baseMessage({ content: 'line one\nline two' })}
        agentNameById={agentNameById}
        renderMode="md"
      />
    );

    const bubble = container.querySelector('[data-tid="userBubble"]');
    expect(bubble?.textContent).toContain('line one\nline two');
    expect(bubble?.textContent).not.toContain('\\');
    expect(bubble?.querySelector('br')).toBeTruthy();
  });

  it('preserves an intentional literal backslash before a rendered chat newline', () => {
    const { container } = render(
      <MessageRow
        message={baseMessage({ content: 'literal\\\nnext' })}
        agentNameById={agentNameById}
        renderMode="md"
      />
    );

    const bubble = container.querySelector('[data-tid="userBubble"]');
    expect(bubble?.textContent).toContain('literal\\\nnext');
    expect(bubble?.querySelector('br')).toBeTruthy();
  });
});

describe('MessageRow — text selection safety', () => {
  // Partial text selection in bubbles fails if anything between the message
  // text and the row root intercepts the gesture (see also
  // PaneChrome.activation.test.tsx and useTreeClipboard.test.tsx). That DOM
  // stays selection-neutral, with no draggable elements and no
  // default-prevented mousedown, for both user and agent messages.
  const cases: Array<[string, Partial<ThreadMessage>]> = [
    ['user message', { role: 'user', content: 'copy part of me' }],
    ['agent message', { role: 'assistant', agentId: 'agent-1', content: 'copy part of me' }],
  ];

  it.each(cases)('%s: no draggable ancestors and mousedown stays defaultable', (_label, over) => {
    const { container } = render(
      <MessageRow message={baseMessage(over)} agentNameById={agentNameById} renderMode="raw" />
    );

    const text = screen.getByText('copy part of me');
    // No element between the text and the row root opts into native drag
    // (a draggable ancestor turns a selection swipe into a drag gesture).
    let el: HTMLElement | null = text;
    while (el && el !== container) {
      expect(el.draggable).toBe(false);
      el = el.parentElement;
    }

    // The mousedown that begins a selection must survive the bubble chain
    // undefaulted — a preventDefault here kills selection before it starts.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    text.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
  });
});

describe('MessageRow — user bubble timestamp', () => {
  it('shows the send time in the user bubble header, like agent bubbles', () => {
    const { container } = render(
      <MessageRow
        message={baseMessage({ content: 'timed', createdAt: new Date().toISOString() })}
        agentNameById={agentNameById}
        renderMode="raw"
      />
    );
    const stamp = container.querySelector('[data-tid="userBubble"] [class*="timestamp"]');
    expect(stamp).toBeTruthy();
    expect(stamp?.textContent).toMatch(/\d/);
  });

  it('writes a 12-hour time without a leading zero, and the date for an older day', () => {
    const today = new Date();
    today.setHours(20, 33, 0, 0);
    const { container, rerender } = render(
      <MessageRow
        message={baseMessage({ content: 'timed', createdAt: today.toISOString() })}
        agentNameById={agentNameById}
        renderMode="raw"
      />
    );
    const stamp = () =>
      container.querySelector('[data-tid="userBubble"] [class*="timestamp"]')?.textContent;
    expect(stamp()).toMatch(/^8:33\sPM$/);

    rerender(
      <MessageRow
        message={baseMessage({
          content: 'timed',
          createdAt: new Date(2026, 5, 28, 9, 5).toISOString(),
        })}
        agentNameById={agentNameById}
        renderMode="raw"
      />
    );
    expect(stamp()).toMatch(/^Jun 28 9:05\sAM$/);
  });

  it('hides the timestamp while the optimistic send is still pending', () => {
    const { container } = render(
      <MessageRow
        message={baseMessage({ content: 'sending', pending: true })}
        agentNameById={agentNameById}
        renderMode="raw"
      />
    );
    expect(container.querySelector('[data-tid="userBubble"] [class*="timestamp"]')).toBeNull();
  });
});

describe('MessageRow — ghost system author label', () => {
  const names = new Map([
    ['ghost', 'ghost'],
    ['agent-venus', 'Venus'],
  ]);
  const render1 = (over: Partial<ThreadMessage>) =>
    render(
      <MessageRow
        message={baseMessage({ role: 'assistant', content: 'PR merged', ...over })}
        agentNameById={names}
        renderMode="raw"
      />
    );

  it('shows "system" for a ghost hook post (no originalAgentName)', () => {
    render1({ agentId: 'ghost' });
    expect(screen.getByText('system')).toBeTruthy();
    expect(screen.queryByText('ghost')).toBeNull();
  });

  it('keeps "ghost" for a deleted agent\'s message (originalAgentName stamped)', () => {
    render1({ agentId: 'ghost', originalAgentName: 'Bill' });
    expect(screen.getByText('ghost')).toBeTruthy();
    expect(screen.queryByText('system')).toBeNull();
  });

  it('is unchanged for an ordinary agent', () => {
    render1({ agentId: 'agent-venus' });
    expect(screen.getByText('venus')).toBeTruthy();
  });
});

describe('MessageRow — avatar in the agent name tag', () => {
  const agentMsg = baseMessage({ id: 'a-1', role: 'assistant', agentId: 'bob', content: 'hi' });
  const names = new Map([['bob', 'Bob']]);

  it('draws the agent avatar inside the name tag when tagAvatarFor is given', () => {
    const seen: string[] = [];
    const { container } = render(
      <MessageRow
        message={agentMsg}
        agentNameById={names}
        renderMode="raw"
        tagAvatarFor={(id) => {
          seen.push(id);
          return <i data-testid="flower" />;
        }}
      />
    );
    const avatar = container.querySelector('[data-tid="tagAvatar"]');
    expect(avatar).not.toBeNull();
    expect(avatar?.querySelector('[data-testid="flower"]')).not.toBeNull();
    expect(avatar?.parentElement?.textContent).toContain('bob');
    expect(seen).toEqual(['bob']);
  });

  it('renders no avatar without tagAvatarFor, and none on a user bubble', () => {
    const { container: plain } = render(
      <MessageRow message={agentMsg} agentNameById={names} renderMode="raw" />
    );
    expect(plain.querySelector('[data-tid="tagAvatar"]')).toBeNull();
    const { container: user } = render(
      <MessageRow
        message={baseMessage({ id: 'u-1' })}
        agentNameById={names}
        renderMode="raw"
        tagAvatarFor={() => <i />}
      />
    );
    expect(user.querySelector('[data-tid="tagAvatar"]')).toBeNull();
  });
});
