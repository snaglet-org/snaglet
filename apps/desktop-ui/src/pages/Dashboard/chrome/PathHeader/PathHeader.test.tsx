/**
 * PathHeader's double-click rename, the top bar interaction docs, containers
 * and threads share: the title swaps for the workspace tree's `RenameInput`;
 * Enter or blur saves, Escape reverts, and there are no buttons.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PathHeader, type PathHeaderRename } from './PathHeader';

function renderHeader(props: {
  onRename?: (title: string) => Promise<void> | void;
  rename?: PathHeaderRename;
}) {
  return render(
    <PathHeader id="doc-1111111111111-aaaaaaaaa" title="Notes" ancestors={['Team']} {...props} />
  );
}

async function startRename() {
  fireEvent.doubleClick(screen.getByText('Notes'));
  const input = await screen.findByRole('textbox', { name: 'Rename' });
  expect(input).toHaveFocus();
  return input;
}

describe('PathHeader onRename', () => {
  it('saves the trimmed title once on Enter followed by blur', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    renderHeader({ onRename });
    const input = await startRename();
    expect(input).toHaveValue('Notes');
    expect(screen.queryByRole('button', { name: /save|cancel/i })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: '  Minutes ' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.blur(input);
    });

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith('Minutes');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('saves on blur', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    renderHeader({ onRename });
    const input = await startRename();
    fireEvent.change(input, { target: { value: 'Minutes' } });
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(onRename).toHaveBeenCalledWith('Minutes');
  });

  it('closes without a call for an empty or unchanged title, and on Escape', async () => {
    const onRename = vi.fn();
    renderHeader({ onRename });

    for (const value of ['   ', 'Notes']) {
      const input = await startRename();
      fireEvent.change(input, { target: { value } });
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' });
      });
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    }

    const input = await startRename();
    fireEvent.change(input, { target: { value: 'Minutes' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(onRename).not.toHaveBeenCalled();
  });

  it('closes on a failed rename and reports it in the header tooltip', async () => {
    const onRename = vi.fn().mockRejectedValue(new Error('Rename refused'));
    const { container } = renderHeader({ onRename });
    const input = await startRename();
    fireEvent.change(input, { target: { value: 'Minutes' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('title', 'Rename refused');
  });

  it('keeps a plain title with no rename affordance', () => {
    renderHeader({});
    const title = screen.getByText('Notes');
    expect(title).not.toHaveAttribute('title');
    fireEvent.doubleClick(title);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('PathHeader caller-owned rename', () => {
  it('opens through the caller and shows its error beside a field that stays open', async () => {
    const session: PathHeaderRename = {
      editing: false,
      begin: vi.fn(),
      submit: vi.fn().mockResolvedValue(false),
      cancel: vi.fn(),
      change: vi.fn(),
    };
    const { rerender } = renderHeader({ rename: session });
    fireEvent.doubleClick(screen.getByText('Notes'));
    expect(session.begin).toHaveBeenCalledTimes(1);

    const header = (next: Partial<PathHeaderRename>) => (
      <PathHeader
        id="doc-1111111111111-aaaaaaaaa"
        title="Notes"
        ancestors={[]}
        rename={{ ...session, editing: true, ...next }}
      />
    );
    rerender(header({}));
    const input = await screen.findByRole('textbox', { name: 'Rename' });
    fireEvent.change(input, { target: { value: 'Bad name' } });
    expect(session.change).toHaveBeenLastCalledWith('Bad name');

    rerender(header({ error: 'Use only lowercase letters.' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Use only lowercase letters.');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(session.submit).toHaveBeenCalledWith('Bad name');
    expect(screen.getByRole('textbox', { name: 'Rename' })).toBe(input);
    expect(input).toHaveValue('Bad name');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(session.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('PathHeader in a narrow pane', () => {
  it('runs the ancestors as one truncating span ahead of the title, with the full path as the tooltip', () => {
    const { container } = render(
      <PathHeader
        id="doc-1111111111111-aaaaaaaaa"
        title="Welcome to Snaglet"
        ancestors={['Onboarding', 'Start here']}
      />
    );
    const header = container.firstElementChild!;
    expect(header).toHaveAttribute('title', '/Onboarding/Start here/Welcome to Snaglet');
    // One run of text, so it ellipsizes as a whole before the title shrinks.
    expect(screen.getByText('Onboarding / Start here')).toBeInTheDocument();
    expect(screen.getByText('Welcome to Snaglet')).toBeInTheDocument();
    const text = header.textContent ?? '';
    expect(text.indexOf('Start here')).toBeLessThan(text.indexOf('Welcome to Snaglet'));
  });

  it('shows no path for a root-level node, only the title', () => {
    render(<PathHeader id="doc-1111111111111-aaaaaaaaa" title="Notes" ancestors={[]} />);
    expect(screen.getByText('Notes')).toBeInTheDocument();
    expect(screen.getAllByText('/')).toHaveLength(1);
  });
});
