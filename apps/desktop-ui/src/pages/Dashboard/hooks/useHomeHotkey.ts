import { useEffect, useRef } from 'react';
import { HUB_HOME_FLAG } from '@snaglet/shared/types';
import { useFeatureFlag } from '@desktop/features/featureFlags/FeatureFlagsContext';
import { paneShortcutFor } from '../chrome/PaneChrome/paneShortcuts';

/**
 * ⌘⇧H opens Home in the active pane, pushed on that pane's history like any
 * other visit so ⌘[ returns to where you were. Bound only while `hub_home`
 * is on; with it off the key does nothing. Left to text fields and modals
 * (see paneShortcutFor).
 */
export function useHomeHotkey(openHome: () => void): void {
  const enabled = useFeatureFlag(HUB_HOME_FLAG);
  const openRef = useRef(openHome);
  openRef.current = openHome;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (paneShortcutFor(event) !== 'home') return;
      event.preventDefault();
      if (!event.repeat) openRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
