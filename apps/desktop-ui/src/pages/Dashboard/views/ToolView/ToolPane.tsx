import { useCallback, useMemo, useState, type FC } from 'react';
import type { ToolRow } from '@desktop/utils/api';
import { ToolBuilderPanel, toolIdFromSource } from '@desktop/components/ToolBuilderPanel';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import type { DetailSelection } from '@desktop/pages/Dashboard/selection/types';
import { ToolView } from './ToolView';

interface ToolPaneProps {
  tool?: ToolRow;
  create?: boolean;
  /**
   * Initial-mode hint from the selection's `tool.edit`, read once on mount.
   * `DetailRouter` keys this component by `tool.id`, so another tool gets a
   * fresh instance; switching modes on the same tool is local state.
   */
  startEditing?: boolean;
  /**
   * Swaps this pane's selection. After Create tool the pane becomes the new
   * tool's own `kind: 'tool'` selection, so its title, history and restored
   * snapshot name the tool instead of "New tool".
   */
  onReplaceSelection?: (selection: DetailSelection) => void;
}

/**
 * The pane surface for one tool, with two faces under one `kind: 'tool'`
 * selection: view/run (ToolView) and edit (ToolBuilderPanel, workspace tools
 * only). The face is local state, so switching never touches pane history,
 * and entering edit mounts a fresh builder. A save updates `liveTool` and
 * emits `tool-saved` for the sidebar's own copy of the row. The builder calls
 * `onSaved` then `onClose` in one tick, so the flip back to ToolView happens
 * in `handleSaved` and `handleClose` is only Cancel. ToolView's Edit button
 * is gated by `toolIdFromSource`, like the sidebar pencil.
 */
export const ToolPane: FC<ToolPaneProps> = ({
  tool,
  create = false,
  startEditing = false,
  onReplaceSelection,
}) => {
  const [mode, setMode] = useState<'view' | 'edit'>(create || startEditing ? 'edit' : 'view');
  const [liveTool, setLiveTool] = useState(tool);

  const handleSaved = useCallback(
    (saved: ToolRow) => {
      setLiveTool(saved);
      setMode('view');
      emitLibraryEvent({ type: 'tool-saved', tool: saved });
      if (create) onReplaceSelection?.({ kind: 'tool', tool: saved });
    },
    [create, onReplaceSelection]
  );

  const handleClose = useCallback(() => {
    if (liveTool) setMode('view');
  }, [liveTool]);
  const handleEdit = useCallback(() => setMode('edit'), []);

  const isWorkspaceTool = useMemo(
    () => toolIdFromSource(liveTool?.source) !== null,
    [liveTool?.source]
  );

  if (mode === 'edit') {
    return (
      <ToolBuilderPanel
        mode={liveTool ? 'edit' : 'create'}
        tool={liveTool}
        onClose={handleClose}
        onSaved={handleSaved}
      />
    );
  }
  if (!liveTool) return null;
  return <ToolView tool={liveTool} onEdit={isWorkspaceTool ? handleEdit : undefined} />;
};
