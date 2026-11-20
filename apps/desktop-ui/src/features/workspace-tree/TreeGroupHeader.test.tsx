/**
 * TreeGroupHeader's optional `+`: it renders only with `onAdd`, creates
 * without toggling the group (by click or by keyboard), is a Tab stop of its
 * own after the header, and leaves the header's own keys working.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TreeGroupHeader } from './TreeGroupHeader';

function renderHeader(props: { onAdd?: () => void; open?: boolean } = {}) {
  const onToggle = vi.fn();
  render(
    <div role="tree">
      <TreeGroupHeader
        label="Tables"
        count={2}
        open={props.open ?? true}
        onToggle={onToggle}
        depth={0}
        groupId="workspace/tables"
        onAdd={props.onAdd}
        addLabel="New table"
      />
    </div>
  );
  return { onToggle, header: screen.getByRole('treeitem', { name: 'Tables (2)' }) };
}

describe('TreeGroupHeader add button', () => {
  it('renders no button without onAdd', () => {
    const { header } = renderHeader();
    expect(within(header).queryByRole('button')).not.toBeInTheDocument();
  });

  it('calls onAdd on click without toggling the group', () => {
    const onAdd = vi.fn();
    const { header, onToggle } = renderHeader({ onAdd });
    const add = within(header).getByRole('button', { name: 'New table' });
    expect(add).toHaveAttribute('title', 'New table');

    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();

    // The header itself still toggles.
    fireEvent.click(header);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('is reached by Tab after the header and activates by keyboard without toggling', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const { header, onToggle } = renderHeader({ onAdd, open: false });
    const add = within(header).getByRole('button', { name: 'New table' });

    header.focus();
    await user.keyboard('{ArrowRight}');
    expect(onToggle).toHaveBeenCalledTimes(1);

    await user.tab();
    expect(add).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onAdd).toHaveBeenCalledTimes(2);
    // Keys aimed at the button never reach the header's toggle.
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
