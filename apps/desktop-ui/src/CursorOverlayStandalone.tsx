import { useEffect, type FC } from 'react';
import { defaultWorkspaceColors } from '@snaglet/shared/constants/workspaceTheme';
import { AgentCursorOverlay } from '@desktop/components/AgentCursorOverlay';
import { initializeWorkspaceTheme, refreshWorkspaceTheme } from '@desktop/utils/workspaceTheme';
import { WebSocketProvider } from '@desktop/ws/WebSocketContext';
import { WorkspaceThemeSync } from '@desktop/ws/WorkspaceThemeSync';

const THEME_REFRESH_MS = 15_000;
// First-paint fallback until the saved workspace theme loads: the default
// workspace palette (not black and white), as a stylesheet rule (not inline
// style) so the theme's inline values win. Also makes the page transparent,
// unscrollable and click-through.
const BASE_CSS =
  `:root{${Object.entries(defaultWorkspaceColors)
    .map(([name, color]) => `--${name}:${color}`)
    .join(';')}}` +
  'html,body,#root{background:transparent!important;margin:0;overflow:hidden;pointer-events:none!important;user-select:none}' +
  '*{pointer-events:none!important}';

/**
 * Entry for the system-wide cursor overlay (`/?cursorOverlay=1`). The native
 * overlay window loads this: a transparent, strictly click-through page that
 * draws only agent flowers. Nothing here is interactive.
 */
export const CursorOverlayStandalone: FC = () => {
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = BASE_CSS;
    document.head.prepend(style);
    // The native window stays invisible until it reads this marker.
    document.documentElement.setAttribute('data-snaglet-cursor-overlay', '1');
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    void initializeWorkspaceTheme();
    const refresh = () => void refreshWorkspaceTheme();
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, THEME_REFRESH_MS);
    return () => {
      window.removeEventListener('focus', refresh);
      window.clearInterval(timer);
      style.remove();
      document.documentElement.removeAttribute('data-snaglet-cursor-overlay');
    };
  }, []);
  return (
    <WebSocketProvider>
      <WorkspaceThemeSync />
      <AgentCursorOverlay standalone />
    </WebSocketProvider>
  );
};
