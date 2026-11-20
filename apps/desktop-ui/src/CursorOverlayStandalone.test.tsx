import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@desktop/components/AgentCursorOverlay', () => ({
  AgentCursorOverlay: ({ standalone }: { standalone?: boolean }) => (
    <div data-testid="overlay" data-standalone={String(!!standalone)} />
  ),
}));
vi.mock('@desktop/ws/WebSocketContext', () => ({
  WebSocketProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@desktop/ws/WorkspaceThemeSync', () => ({ WorkspaceThemeSync: () => null }));
vi.mock('@desktop/utils/workspaceTheme', () => ({
  initializeWorkspaceTheme: vi.fn(() => Promise.resolve()),
  refreshWorkspaceTheme: vi.fn(() => Promise.resolve()),
}));

import { CursorOverlayStandalone } from './CursorOverlayStandalone';

describe('CursorOverlayStandalone', () => {
  it('renders only the standalone overlay on a transparent click-through page', () => {
    const { getByTestId } = render(<CursorOverlayStandalone />);
    expect(getByTestId('overlay').dataset.standalone).toBe('true');
    expect(document.body.style.background).toBe('transparent');
    const css = [...document.head.querySelectorAll('style')].map((s) => s.textContent).join('');
    expect(css).toContain('pointer-events:none');
  });
});
