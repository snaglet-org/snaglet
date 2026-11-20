import { useCallback, useState, type FC } from 'react';
import type { HookWorkspaceInfo } from '@desktop/utils/api';
import { HookBuilderPanel } from '@desktop/components/HookBuilderPanel';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';

interface HookBuilderViewProps {
  hook?: HookWorkspaceInfo;
}

/**
 * HookBuilderView — the pane-hosted page for a single script (a hook). A
 * script has no separate view/run face (testing lives inside the builder's
 * HookTestConsole), so this is a thin host: `HookBuilderPanel` in
 * `mode: 'edit'` is the whole pane body, for both a plain row click and the
 * row's Edit pencil (the Automations list routes both to the same
 * `{ kind: 'hook', hook }` selection).
 *
 * `onClose` is a no-op here: with no other face to flip back to, "Cancel"
 * only ever means "discard my in-flight code edit", which HookBuilderPanel's
 * `handleRequestClose` already resets before calling it. Saving updates
 * `liveHook` (kept local so this component doesn't re-fetch after a save) and
 * emits `hook-saved` so the Automations list stays in sync without a
 * full reload.
 */
export const HookBuilderView: FC<HookBuilderViewProps> = ({ hook }) => {
  const [liveHook, setLiveHook] = useState(hook);

  const handleSaved = useCallback((saved: HookWorkspaceInfo) => {
    setLiveHook(saved);
    emitLibraryEvent({ type: 'hook-saved', hook: saved });
  }, []);

  const handleClose = useCallback(() => {
    // No separate surface to fall back to — see doc comment above.
  }, []);

  return (
    <HookBuilderPanel
      mode={liveHook ? 'edit' : 'create'}
      hook={liveHook}
      onClose={handleClose}
      onSaved={handleSaved}
    />
  );
};
