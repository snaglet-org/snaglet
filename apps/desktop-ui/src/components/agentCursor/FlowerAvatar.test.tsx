import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultCursorSpec } from '@snaglet/shared/cursor';
import { THEME_CHANGED } from '@desktop/utils/workspaceTheme';
import { FlowerAvatar } from './FlowerAvatar';

afterEach(() => document.documentElement.removeAttribute('style'));
const spec = defaultCursorSpec('agent-1');

describe('FlowerAvatar', () => {
  it('renders an img named for the emotion, animated by default', () => {
    const { container } = render(<FlowerAvatar spec={spec} emotion="happy" size={56} />);
    expect(screen.getByRole('img', { name: /happy/i })).toBeInTheDocument();
    expect(container.querySelectorAll('animateTransform').length).toBeGreaterThan(0);
  });
  it('is a static pose when animate is false', () => {
    const { container } = render(
      <FlowerAvatar spec={spec} emotion="happy" size={56} animate={false} />
    );
    expect(container.querySelectorAll('animateTransform')).toHaveLength(0);
    expect(container.querySelector('path')).not.toBeNull();
  });
  it('recolors when the palette changes', () => {
    const { container } = render(<FlowerAvatar spec={spec} emotion="neutral" size={56} />);
    const fill = () => container.querySelector('path[fill]')?.getAttribute('fill');
    const before = [...container.querySelectorAll('path,circle')].map((n) =>
      n.getAttribute('fill')
    );
    for (const name of [
      'detail',
      'detail-2',
      'agent',
      'text',
      'background',
      'border',
      'foreground',
      'selected',
    ])
      document.documentElement.style.setProperty(`--${name}`, '#0a0b0c');
    act(() => void window.dispatchEvent(new Event(THEME_CHANGED)));
    const after = [...container.querySelectorAll('path,circle')].map((n) => n.getAttribute('fill'));
    expect(after).not.toEqual(before);
    expect(fill()).toBeTruthy();
  });
});

it('flutters only petals and keeps the face outside the animated petal group', () => {
  const { container } = render(
    <FlowerAvatar spec={defaultCursorSpec('flutter')} emotion="happy" size={56} />
  );
  const petals = container.querySelector('[data-petal-flutter="true"]');
  expect(petals).not.toBeNull();
  expect(petals?.querySelector('animateTransform')).not.toBeNull();
  expect(petals?.querySelector('circle')).toBeNull();
});
