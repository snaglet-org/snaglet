import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tooltip } from './Tooltip';
import { HelpTooltip } from './HelpTooltip';
import styles from './Tooltip.module.scss';

// jsdom lays nothing out and vitest does not inject CSS modules, so the
// wrapping contract is checked two ways: the bubble carries the class, and
// the stylesheet gives that class the rules that keep text inside the box.
const scss = readFileSync(join(__dirname, 'Tooltip.module.scss'), 'utf8');
const block = (selector: string): string => {
  const start = scss.indexOf(`${selector} {`);
  expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return scss.slice(start, scss.indexOf('\n}', start));
};

// The bubble opens after a hover delay; use a small delay so tests stay fast.
function renderTooltip(label = 'Workspace tree') {
  return render(
    <Tooltip label={label} delay={0}>
      <button type="button">icon</button>
    </Tooltip>
  );
}

describe('Tooltip', () => {
  it('shows the chat-bubble on hover and hides on mouse-out', async () => {
    const user = userEvent.setup();
    renderTooltip();
    const trigger = screen.getByRole('button', { name: 'icon' });

    expect(screen.queryByRole('tooltip')).toBeNull();

    await user.hover(trigger);
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Workspace tree'));

    await user.unhover(trigger);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('shows on keyboard focus and closes on Escape', async () => {
    const user = userEvent.setup();
    renderTooltip('Agents');
    const trigger = screen.getByRole('button', { name: 'icon' });

    trigger.focus();
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Agents'));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('associates the bubble with the trigger via aria-describedby', async () => {
    const user = userEvent.setup();
    renderTooltip();
    const trigger = screen.getByRole('button', { name: 'icon' });

    await user.hover(trigger);
    await waitFor(() => {
      const bubble = screen.getByRole('tooltip');
      expect(trigger.getAttribute('aria-describedby')).toBe(bubble.id);
    });
  });

  it('wraps its text inside the bubble: the box has a cap and text breaks anywhere', async () => {
    const longWord = 'thread-1111111111111-aaaaaaaaa/entry-0f3c2a9d8b7e6f5a4c3b2a1d0e9f8a7b';
    renderTooltip(`Every week on Saturday, open until the next one ${longWord}`);
    screen.getByRole('button', { name: 'icon' }).focus();
    const bubble = await screen.findByRole('tooltip');

    expect(bubble).toHaveClass(styles.bubble);
    const rule = block('.bubble');
    expect(rule).toMatch(/white-space: normal;/);
    expect(rule).toMatch(/overflow-wrap: anywhere;/);
    expect(rule).toMatch(/box-sizing: border-box;/);
    expect(rule).toMatch(/max-width: min\(280px,/);
    expect(rule).not.toMatch(/nowrap/);
    // Flex/grid items inside a rich label must not keep min-width:auto.
    expect(scss).toMatch(/:where\(\.bubble\) \* \{\s*min-width: 0;/);
  });

  it('keeps a caller class alongside the wrapping class', async () => {
    render(
      <Tooltip label="Clear" delay={0} className="caller">
        <button type="button">icon</button>
      </Tooltip>
    );
    screen.getByRole('button', { name: 'icon' }).focus();
    const bubble = await screen.findByRole('tooltip');
    expect(bubble).toHaveClass(styles.bubble);
    expect(bubble).toHaveClass('caller');
  });

  it('preserves the child’s own handlers', async () => {
    const user = userEvent.setup();
    let clicked = false;
    render(
      <Tooltip label="Tools" delay={0}>
        <button type="button" onClick={() => (clicked = true)}>
          icon
        </button>
      </Tooltip>
    );
    await user.click(screen.getByRole('button', { name: 'icon' }));
    expect(clicked).toBe(true);
  });
});

describe('HelpTooltip', () => {
  it('uses a meaningful accessible label and opens on keyboard focus', async () => {
    render(<HelpTooltip label="How routing waves work" ariaLabel="About dispatch waves" />);
    const trigger = screen.getByRole('button', { name: 'About dispatch waves' });

    trigger.focus();
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent('How routing waves work')
    );
  });

  it('widens the cap for help text and never turns wrapping back off', async () => {
    render(<HelpTooltip label="A few sentences of help." ariaLabel="About it" />);
    screen.getByRole('button', { name: 'About it' }).focus();
    const bubble = await screen.findByRole('tooltip');
    expect(bubble).toHaveClass(styles.bubble);
    expect(bubble).toHaveClass(styles.helpBubble);
    const rule = block('.helpBubble');
    expect(rule).toMatch(/max-width: min\(320px,/);
    expect(rule).not.toMatch(/nowrap|width: max-content/);
  });
});

describe('HelpTooltip inside a label', () => {
  function renderField() {
    render(
      <label>
        <span>
          query
          <HelpTooltip label="What to search for" ariaLabel="About query" side="right" />
        </span>
        <div contentEditable suppressContentEditableWarning aria-label="query (string)" />
      </label>
    );
    return {
      trigger: screen.getByRole('button', { name: 'About query' }),
      input: screen.getByLabelText('query (string)'),
    };
  }

  it('is never the control the label forwards clicks and focus to', async () => {
    const user = userEvent.setup();
    const { trigger, input } = renderField();
    expect(trigger.closest('label')?.control).toBeNull();
    await user.click(input);
    expect(document.activeElement).not.toBe(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps a click on the hint from activating the label', async () => {
    const user = userEvent.setup();
    let labelClicks = 0;
    render(
      <label>
        <HelpTooltip label="How many rows" ariaLabel="About limit" />
        <input aria-label="limit" onClick={() => (labelClicks += 1)} />
      </label>
    );
    await user.click(screen.getByRole('button', { name: 'About limit' }));
    expect(labelClicks).toBe(0);
    expect(document.activeElement).not.toBe(screen.getByLabelText('limit'));
  });

  it('never takes pointer events on its bubble', async () => {
    const trigger = renderField().trigger;
    trigger.focus();
    const bubble = await screen.findByRole('tooltip');
    expect(bubble.className).toMatch(/bubble/);
    expect(getComputedStyle(bubble).pointerEvents).toBe('none');
  });
});
