import { useEffect, type FC } from 'react';
import { defaultWorkspaceColors } from '@snaglet/shared/constants/workspaceTheme';
import { AgentPopups } from '@desktop/components/AgentPopups';
import { getApiUrl } from '@desktop/utils/api';
import { initializeWorkspaceTheme, refreshWorkspaceTheme } from '@desktop/utils/workspaceTheme';
import { WebSocketProvider } from '@desktop/ws/WebSocketContext';
import { WorkspaceThemeSync } from '@desktop/ws/WorkspaceThemeSync';

const THEME_REFRESH_MS = 15_000;
const HEARTBEAT_MS = 3000;
const NATIVE_ASK_WINDOW_UA = 'SnagletAskOverlay';
// Transparent page; the native window sizes itself to the card stack and is hidden
// when nothing is pending, so (unlike the cursor overlay) the cards take input.
const BASE_CSS =
  `:root{${Object.entries(defaultWorkspaceColors)
    .map(([name, color]) => `--${name}:${color}`)
    .join(';')}}` +
  'html,body,#root{background:transparent!important;margin:0;overflow:hidden}' +
  '.snaglet-agent-popups{position:fixed!important;left:0;right:0;bottom:0;top:auto;width:auto!important;max-height:none!important;padding:0}';

/**
 * Entry for the system-wide ask window (`/?askOverlay=1`). The native window loads
 * this: agent questions and permission prompts from any chat, answerable from
 * anywhere on the desktop. It reports its card-stack height to the native side
 * through the DOM (the `.snaglet-agent-popups` root), which sizes and shows the window.
 */
export const AskOverlayStandalone: FC = () => {
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = BASE_CSS;
    document.head.prepend(style);
    document.documentElement.setAttribute('data-snaglet-ask-overlay', '1');
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    void initializeWorkspaceTheme();
    const refresh = () => void refreshWorkspaceTheme();
    window.addEventListener('focus', refresh);
    const themeTimer = window.setInterval(refresh, THEME_REFRESH_MS);
    // Only the native window counts as "the ask window running"; a browser tab does not.
    let beatTimer: number | undefined;
    if (navigator.userAgent.includes(NATIVE_ASK_WINDOW_UA)) {
      const beat = () =>
        void fetch(getApiUrl('/computer/ask-overlay-heartbeat'), { method: 'POST' }).catch((err) =>
          console.debug('[ask] heartbeat failed', err)
        );
      beat();
      beatTimer = window.setInterval(beat, HEARTBEAT_MS);
    }
    return () => {
      window.removeEventListener('focus', refresh);
      window.clearInterval(themeTimer);
      if (beatTimer !== undefined) window.clearInterval(beatTimer);
      style.remove();
      document.documentElement.removeAttribute('data-snaglet-ask-overlay');
    };
  }, []);
  return (
    <WebSocketProvider>
      <WorkspaceThemeSync />
      <AgentPopups standalone />
    </WebSocketProvider>
  );
};
