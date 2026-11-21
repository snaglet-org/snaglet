import { type FC, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ToastHost, WsStatusIndicator } from '@desktop/components';
import { AgentPopups } from '@desktop/components/AgentPopups';
import { AppUpdatePrompt } from '@desktop/components/AppUpdatePrompt';
import { AgentCursorApproval } from '@desktop/components/AgentCursorApproval';
import { AgentCursorOverlay } from '@desktop/components/AgentCursorOverlay';
import { setActiveUserId } from '@desktop/config';
import { Dashboard } from '@desktop/pages/Dashboard';
import type { BaseComponentProps } from '@desktop/types';
import { userProfileApi } from '@desktop/utils/api';
import { WebSocketProvider } from '@desktop/ws/WebSocketContext';
import { WorkspaceThemeSync } from '@desktop/ws/WorkspaceThemeSync';
import { FeatureFlagsProvider } from '@desktop/features/featureFlags/FeatureFlagsContext';

import { initializeWorkspaceTheme } from '@desktop/utils/workspaceTheme';
import { installExternalLinkOpener } from '@desktop/utils/externalLinks';

export const App: FC<BaseComponentProps> = () => {
  useEffect(() => {
    void initializeWorkspaceTheme();
  }, []);
  // Desktop shell: web/mail links leave for the system browser (see
  // utils/externalLinks for why the shell's own hook is not enough).
  useEffect(() => installExternalLinkOpener(), []);
  const buildProfile = import.meta.env.VITE_SNAGLET_BUILD_PROFILE;
  const showBuildProfileBanner = import.meta.env.VITE_SNAGLET_SHOW_BUILD_PROFILE_BANNER === 'true';
  // Seed the active-user identity on startup: prefer the DB-flagged active user,
  // fall back to the first user. Persists both in DB (active=true) and localStorage
  // so the x-snaglet-actor-id header is stamped on every subsequent HTTP request.
  useEffect(() => {
    userProfileApi
      .listUsers()
      .then((list) => {
        if (list.length === 0) return;
        const already = list.find((u) => u.active) ?? list[0];
        setActiveUserId(String(already.id));
        if (!already.active) {
          void userProfileApi.setActive(already.id).catch((err: unknown) => {
            console.error('App: failed to activate user profile', err);
          });
        }
      })
      .catch((err: unknown) => {
        // Non-fatal: the app still works without a resolved profile.
        console.error('App: failed to load user profiles', err);
      });
  }, []);
  return (
    <FeatureFlagsProvider>
      <WebSocketProvider>
        <WorkspaceThemeSync />
        {buildProfile === 'browser-preview' && showBuildProfileBanner && (
          <div
            data-testid="build-profile-banner"
            role="status"
            style={{
              background: '#8f1d4f',
              borderRadius: '0 0 0 4px',
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              padding: '5px 10px',
              position: 'fixed',
              right: 0,
              top: 0,
              zIndex: 10_000,
            }}
          >
            Snaglet Browser Preview
          </div>
        )}
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
        <ToastHost />
        <AppUpdatePrompt />
        <WsStatusIndicator />
        <AgentCursorOverlay />
        <AgentCursorApproval />
        <AgentPopups />
      </WebSocketProvider>
    </FeatureFlagsProvider>
  );
};
