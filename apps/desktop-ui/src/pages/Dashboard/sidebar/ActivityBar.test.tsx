import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolIcon } from '@desktop/components/Icons';
import { ActivityBar } from './ActivityBar';

vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  useFeatureFlag: () => false,
}));

describe('ActivityBar', () => {
  it('draws MCP as a decorative glyph while keeping the accessible tab label', () => {
    render(<ActivityBar active="library" onSelect={vi.fn()} />);

    const mcpTab = screen.getByRole('tab', { name: 'MCP' });
    const glyph = mcpTab.querySelector('svg');

    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('ActivityBar workspace, agents and tools glyphs', () => {
  it('draws the agent flower as a decorative glyph under the Agents label', () => {
    render(<ActivityBar active="library" onSelect={vi.fn()} />);
    const glyph = screen.getByRole('tab', { name: 'Agents' }).querySelector('svg');
    expect(glyph?.getAttribute('data-icon')).toBe('agents');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(glyph?.getAttribute('stroke')).toBe('currentColor');
  });

  it('draws the tree as a decorative glyph under the Workspace label', () => {
    render(<ActivityBar active="library" onSelect={vi.fn()} />);
    const glyph = screen.getByRole('tab', { name: 'Workspace' }).querySelector('svg');
    expect(glyph?.getAttribute('data-icon')).toBe('workspace');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(glyph?.getAttribute('stroke')).toBe('currentColor');
    expect(glyph?.querySelectorAll('path').length).toBeGreaterThan(0);
  });

  it('draws the shared shovel glyph under the Tools label', () => {
    const { container: tool } = render(<ToolIcon />);
    const toolPaths = [...tool.querySelectorAll('path')].map((path) => path.getAttribute('d'));
    render(<ActivityBar active="library" onSelect={vi.fn()} />);
    const glyph = screen.getByRole('tab', { name: 'Tools' }).querySelector('svg');
    expect(glyph?.getAttribute('data-icon')).toBe('tool');
    expect(
      [...(glyph?.querySelectorAll('path') ?? [])].map((path) => path.getAttribute('d'))
    ).toEqual(toolPaths);
    expect(glyph?.getAttribute('width')).toBe('20');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(glyph?.getAttribute('stroke')).toBe('currentColor');
  });
});

describe('ActivityBar calendar tab', () => {
  it('sits right after Workspace and selects the calendar view', () => {
    const onSelect = vi.fn();
    render(<ActivityBar active="library" onSelect={onSelect} />);
    const labels = screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'));
    expect(labels.indexOf('Calendar')).toBe(labels.indexOf('Workspace') + 1);
    screen.getByRole('tab', { name: 'Calendar' }).click();
    expect(onSelect).toHaveBeenCalledWith('calendar');
  });
});

describe('ActivityBar automations tab', () => {
  it('sits right after Skills, draws the swirl and selects the automations view', () => {
    const onSelect = vi.fn();
    render(<ActivityBar active="library" onSelect={onSelect} />);
    const labels = screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'));
    expect(labels.indexOf('Automations')).toBe(labels.indexOf('Skills') + 1);
    // Scripts list in Automations: there is no Hooks tab.
    expect(labels).not.toContain('Hooks');

    const tab = screen.getByRole('tab', { name: 'Automations' });
    expect(tab.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    tab.click();
    expect(onSelect).toHaveBeenCalledWith('automations');
  });

  it('spins the swirl only while an automation runs, and says so in the label', () => {
    const { rerender } = render(<ActivityBar active="library" onSelect={vi.fn()} />);
    const still = screen.getByRole('tab', { name: 'Automations' });
    expect(still.querySelector('[data-spinning]')).toBeNull();

    rerender(
      <ActivityBar active="library" onSelect={vi.fn()} activity={{ automations: '1 running' }} />
    );
    const spinning = screen.getByRole('tab', { name: 'Automations · 1 running' });
    expect(spinning.querySelector('[data-spinning] svg')).not.toBeNull();
    // Other glyphs never spin.
    expect(screen.getByRole('tab', { name: 'Skills' }).querySelector('[data-spinning]')).toBeNull();
  });
});

describe('ActivityBar — no DMs view', () => {
  it('has no DMs item: DMs live in each agent’s settings', () => {
    render(<ActivityBar active="library" onSelect={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: 'DMs' })).toBeNull();
    const labels = screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'));
    expect(labels.some((label) => /\bDMs?\b/.test(label ?? ''))).toBe(false);
  });
});
