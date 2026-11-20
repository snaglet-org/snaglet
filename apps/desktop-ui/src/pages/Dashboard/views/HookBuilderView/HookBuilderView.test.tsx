/**
 * HookBuilderView hosts one hook's builder in a pane, as ToolPane does for
 * tools. HookBuilderPanel has its own suite; this file pins the view's own
 * orchestration: the builder always renders in `mode: 'edit'`, a save
 * updates the live copy (and emits the `hook-saved` library event), and
 * `onClose` is a no-op because there is no other face to return to.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { HookWorkspaceInfo } from '@desktop/utils/api';
import { HookBuilderView } from './HookBuilderView';

const { emitLibraryEventMock } = vi.hoisted(() => ({ emitLibraryEventMock: vi.fn() }));
vi.mock('@desktop/utils/workspaceEvents.js', () => ({ emitLibraryEvent: emitLibraryEventMock }));

vi.mock('@desktop/components/HookBuilderPanel/index.js', () => ({
  HookBuilderPanel: ({
    mode,
    hook,
    onClose,
    onSaved,
  }: {
    mode: 'create' | 'edit';
    hook?: HookWorkspaceInfo;
    onClose: () => void;
    onSaved: (hook: HookWorkspaceInfo) => void;
  }) => (
    <div data-testid="hook-builder-panel">
      <span data-testid="mode">{mode}</span>
      <span data-testid="editing-hook">{hook?.hookName}</span>
      <span data-testid="has-build">{String(hook?.hasBuild)}</span>
      <button onClick={onClose}>panel-close</button>
      <button
        onClick={() => {
          if (hook) onSaved({ ...hook, hasBuild: true });
          onClose();
        }}
      >
        panel-save
      </button>
    </div>
  ),
}));

function makeHook(overrides: Partial<HookWorkspaceInfo> & Pick<HookWorkspaceInfo, 'hookName'>) {
  return {
    dir: `/tmp/${overrides.hookName}`,
    homeRelativeDir: `~/.snaglet/hooks/${overrides.hookName}`,
    files: ['hook.ts'],
    hasBuild: false,
    ...overrides,
  };
}

describe('HookBuilderView', () => {
  it('renders the pane builder in create mode when no hook exists yet', () => {
    render(<HookBuilderView />);

    expect(screen.getByTestId('mode')).toHaveTextContent('create');
    expect(screen.getByTestId('editing-hook')).toBeEmptyDOMElement();
  });

  it('always renders the builder in edit mode for the given hook — no separate view/run face', () => {
    render(<HookBuilderView hook={makeHook({ hookName: 'on-message' })} />);

    expect(screen.getByTestId('hook-builder-panel')).toBeInTheDocument();
    expect(screen.getByTestId('mode')).toHaveTextContent('edit');
    expect(screen.getByTestId('editing-hook')).toHaveTextContent('on-message');
  });

  it('onClose is a no-op — the builder stays mounted (there is no other face to fall back to)', async () => {
    const user = userEvent.setup();
    render(<HookBuilderView hook={makeHook({ hookName: 'on-message' })} />);

    await user.click(screen.getByText('panel-close'));

    expect(screen.getByTestId('hook-builder-panel')).toBeInTheDocument();
  });

  it('a successful save updates the live hook passed back in and emits hook-saved for the sidebar', async () => {
    const user = userEvent.setup();
    render(<HookBuilderView hook={makeHook({ hookName: 'on-message', hasBuild: false })} />);

    await user.click(screen.getByText('panel-save'));

    expect(emitLibraryEventMock).toHaveBeenCalledWith({
      type: 'hook-saved',
      hook: expect.objectContaining({ hookName: 'on-message', hasBuild: true }),
    });
    expect(screen.getByTestId('has-build')).toHaveTextContent('true');
  });
});
