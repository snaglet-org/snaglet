/**
 * ToolPane's own orchestration; ToolView and ToolBuilderPanel have their own
 * suites and are stubbed here. Pins which face renders for `startEditing`,
 * what Cancel (`onClose`) does, and what a save does (updates the live copy
 * and emits `tool-saved`). The stub builder's "panel-save" calls `onSaved`
 * then `onClose` in the same tick, as the real one does; in create mode it
 * saves `createdTool`. The stub ToolView renders its `onEdit` as a
 * `view-edit-trigger` button, so the tests pin that only workspace tools get
 * `onEdit` and that it switches to edit. ToolPane.builder.test.tsx drives the
 * same flows through the real builder.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ToolRow } from '@desktop/utils/api';
import { ToolPane } from './ToolPane';

const { emitLibraryEventMock } = vi.hoisted(() => ({ emitLibraryEventMock: vi.fn() }));
vi.mock('@desktop/utils/workspaceEvents.js', () => ({ emitLibraryEvent: emitLibraryEventMock }));

vi.mock('./ToolView.js', () => ({
  ToolView: ({ tool, onEdit }: { tool: ToolRow; onEdit?: () => void }) => (
    <div data-testid="tool-view">
      {tool.name}:{tool.description}
      {onEdit && <button onClick={onEdit}>view-edit-trigger</button>}
    </div>
  ),
}));

vi.mock('@desktop/components/ToolBuilderPanel/index.js', () => ({
  // Mirrors the real `toolIdFromSource` (scaffold.ts's
  // WORKSPACE_SOURCE_PREFIX = 'workspace:') without importing its module,
  // whose ToolBuilderPanel chain needs VITE_* env stubs to load.
  toolIdFromSource: (source: string | null | undefined) =>
    source && source.startsWith('workspace:') ? source.slice('workspace:'.length) : null,
  ToolBuilderPanel: ({
    mode,
    tool,
    onClose,
    onSaved,
  }: {
    mode: string;
    tool: ToolRow;
    onClose: () => void;
    onSaved: (tool: ToolRow) => void;
  }) => (
    <div data-testid="tool-builder-panel">
      <span data-testid="mode">{mode}</span>
      <span data-testid="editing-tool">{tool?.name}</span>
      <button onClick={onClose}>panel-close</button>
      <button
        onClick={() => {
          onSaved(tool ? { ...tool, description: 'Updated' } : createdTool);
          onClose();
        }}
      >
        panel-save
      </button>
    </div>
  ),
}));

function makeTool(overrides: Partial<ToolRow> & Pick<ToolRow, 'id' | 'name'>): ToolRow {
  return {
    description: '',
    type: 'external',
    parametersSchema: {},
    source: 'workspace:my-tool',
    configJson: {},
    aliases: [],
    enabled: true,
    tier: 'standard',
    categoryPath: 'custom',
    providerId: null,
    availability: 'available',
    keywords: [],
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const createdTool = makeTool({ id: 'tool-new', name: 'new-tool', source: 'workspace:new-tool' });

describe('ToolPane', () => {
  it('renders the pane builder in create mode without an existing tool', () => {
    render(<ToolPane create />);

    expect(screen.getByTestId('mode')).toHaveTextContent('create');
    expect(screen.getByTestId('editing-tool')).toBeEmptyDOMElement();
  });

  it('keeps an unsaved create builder mounted when Cancel is clicked', async () => {
    const user = userEvent.setup();
    render(<ToolPane create />);

    await user.click(screen.getByText('panel-close'));

    expect(screen.getByTestId('mode')).toHaveTextContent('create');
  });

  it('defaults to the view/run face (ToolView) when startEditing is omitted', () => {
    render(<ToolPane tool={makeTool({ id: 't', name: 'my-tool' })} />);

    expect(screen.getByTestId('tool-view')).toHaveTextContent('my-tool');
    expect(screen.queryByTestId('tool-builder-panel')).not.toBeInTheDocument();
  });

  it('opens straight into edit mode when startEditing is true (row Edit pencil / post-create hop)', () => {
    render(<ToolPane tool={makeTool({ id: 't', name: 'my-tool' })} startEditing />);

    expect(screen.getByTestId('tool-builder-panel')).toBeInTheDocument();
    expect(screen.getByTestId('mode')).toHaveTextContent('edit');
    expect(screen.getByTestId('editing-tool')).toHaveTextContent('my-tool');
    expect(screen.queryByTestId('tool-view')).not.toBeInTheDocument();
  });

  it('Cancel from the builder (onClose) flips back to the view/run face', async () => {
    const user = userEvent.setup();
    render(<ToolPane tool={makeTool({ id: 't', name: 'my-tool' })} startEditing />);

    await user.click(screen.getByText('panel-close'));

    expect(screen.getByTestId('tool-view')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-builder-panel')).not.toBeInTheDocument();
  });

  it('a successful save shows the fresh data on the view face and emits tool-saved for the sidebar', async () => {
    const user = userEvent.setup();
    render(
      <ToolPane tool={makeTool({ id: 't', name: 'my-tool', description: 'Old' })} startEditing />
    );

    await user.click(screen.getByText('panel-save'));

    expect(screen.getByTestId('tool-view')).toHaveTextContent('Updated');
    expect(emitLibraryEventMock).toHaveBeenCalledWith({
      type: 'tool-saved',
      tool: expect.objectContaining({ id: 't', name: 'my-tool', description: 'Updated' }),
    });
  });

  describe('after Create tool', () => {
    it('replaces the pane selection with the new tool', async () => {
      const user = userEvent.setup();
      const onReplaceSelection = vi.fn();
      render(<ToolPane create onReplaceSelection={onReplaceSelection} />);

      await user.click(screen.getByText('panel-save'));

      expect(onReplaceSelection).toHaveBeenCalledTimes(1);
      expect(onReplaceSelection).toHaveBeenCalledWith({ kind: 'tool', tool: createdTool });
    });

    it('shows the new tool on the view face, not its edit form, and emits tool-saved', async () => {
      const user = userEvent.setup();
      render(<ToolPane create />);

      await user.click(screen.getByText('panel-save'));

      expect(screen.getByTestId('tool-view')).toHaveTextContent('new-tool');
      expect(screen.queryByTestId('tool-builder-panel')).not.toBeInTheDocument();
      expect(emitLibraryEventMock).toHaveBeenCalledWith({ type: 'tool-saved', tool: createdTool });
    });

    it('saving an existing tool keeps the pane selection as it is', async () => {
      const user = userEvent.setup();
      const onReplaceSelection = vi.fn();
      render(
        <ToolPane
          tool={makeTool({ id: 't', name: 'my-tool' })}
          startEditing
          onReplaceSelection={onReplaceSelection}
        />
      );

      await user.click(screen.getByText('panel-save'));

      expect(screen.getByTestId('tool-view')).toHaveTextContent('Updated');
      expect(onReplaceSelection).not.toHaveBeenCalled();
    });
  });

  // Edit affordance — viewing a tool is otherwise read-only, so the view
  // face itself needs its own round-trip into the builder (not just the
  // sidebar's Edit pencil / the create-flow's startEditing hop above).
  describe('view-face Edit trigger', () => {
    it('a workspace-sourced tool gets an onEdit wired to the view face, and clicking it flips to edit mode', async () => {
      const user = userEvent.setup();
      render(
        <ToolPane tool={makeTool({ id: 't', name: 'my-tool', source: 'workspace:my-tool' })} />
      );

      expect(screen.getByTestId('tool-view')).toBeInTheDocument();
      const trigger = screen.getByText('view-edit-trigger');

      await user.click(trigger);

      expect(screen.getByTestId('tool-builder-panel')).toBeInTheDocument();
      expect(screen.getByTestId('mode')).toHaveTextContent('edit');
      expect(screen.getByTestId('editing-tool')).toHaveTextContent('my-tool');
      expect(screen.queryByTestId('tool-view')).not.toBeInTheDocument();
    });

    it('a non-workspace (builtin/mcp) tool gets no onEdit — no folder-backed source for the builder to load', () => {
      render(<ToolPane tool={makeTool({ id: 't', name: 'my-tool', source: null })} />);

      expect(screen.getByTestId('tool-view')).toBeInTheDocument();
      expect(screen.queryByText('view-edit-trigger')).not.toBeInTheDocument();
    });
  });
});
