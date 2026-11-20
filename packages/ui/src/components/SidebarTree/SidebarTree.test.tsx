import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tree, TreeGroup, TreeRow } from './SidebarTree';

describe('SidebarTree', () => {
  it('exposes accessible disclosure state and toggles its group', () => {
    const onToggle = vi.fn();
    render(
      <Tree aria-label="Validation">
        <TreeGroup label="Integration tests" count={2} open={false} onToggle={onToggle} />
      </Tree>
    );

    expect(screen.getByRole('group', { name: 'Validation' })).toBeInTheDocument();
    const group = screen.getByRole('button', { name: /integration tests/i });
    expect(group).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(group, { key: 'Enter' });
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('renders actionable and disabled leaf rows', () => {
    render(
      <Tree aria-label="Tests">
        <TreeRow label="Search integration" chevron="empty" />
        <TreeRow label="Search E2E" chevron="empty" disabled />
      </Tree>
    );

    expect(screen.getByRole('button', { name: 'Search integration' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Search E2E' })).toBeDisabled();
  });

  it('suppresses interactions on disabled display rows', () => {
    const onClick = vi.fn();
    const onDragStart = vi.fn();
    const onToggle = vi.fn();
    render(
      <Tree aria-label="Read-only results">
        <TreeRow
          as="div"
          label="Unavailable result"
          chevron={{ open: false, onToggle, 'aria-label': 'Expand unavailable result' }}
          disabled
          draggable
          tabIndex={0}
          onClick={onClick}
          onDragStart={onDragStart}
        />
      </Tree>
    );

    const row = screen.getByText('Unavailable result').closest('[aria-disabled="true"]');
    expect(row).toHaveAttribute('tabindex', '-1');
    expect(row).toHaveAttribute('draggable', 'false');
    fireEvent.click(row!);
    fireEvent.dragStart(row!);
    fireEvent.click(screen.getByLabelText('Expand unavailable result'));
    expect(onClick).not.toHaveBeenCalled();
    expect(onDragStart).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });
});
