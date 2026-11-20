import { createContext, useContext, useLayoutEffect, type FC } from 'react';
import { Button } from '@desktop/components';

/**
 * "Open in sidebar" for the item a pane shows (reveal it in the sidebar view
 * that owns it). Views with a side panel (Properties for docs, images and
 * containers; Settings for threads) host the button in that panel; the pane
 * topbar keeps it only for views without one, so it is always reachable.
 *
 * The pane provides this context. A view with a side panel calls
 * `useClaimOpenInSidebar()` while mounted, which hides the topbar button, and
 * renders `<OpenInSidebarButton />` inside its panel.
 */
export interface OpenInSidebarContextValue {
  /** The pane's item can be revealed in a sidebar view. */
  available: boolean;
  /** Reveal it. Stable across renders. */
  open: () => void;
  /** Take the button off the topbar while mounted; returns the release. */
  claim: () => () => void;
}

export const OpenInSidebarContext = createContext<OpenInSidebarContextValue | null>(null);

/**
 * Hide the topbar "Open in sidebar" while this view (with a side panel) is
 * mounted, or while `enabled`. A layout effect, so the topbar never paints
 * the button for a frame before the claim lands.
 */
export function useClaimOpenInSidebar(enabled = true): void {
  const claim = useContext(OpenInSidebarContext)?.claim;
  useLayoutEffect(() => (enabled ? claim?.() : undefined), [claim, enabled]);
}

/** The "Open in sidebar" button for a side panel; renders nothing outside a pane. */
export const OpenInSidebarButton: FC<{ className?: string }> = ({ className }) => {
  const ctx = useContext(OpenInSidebarContext);
  if (!ctx?.available) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        ctx.open();
      }}
      title="Open in sidebar"
    >
      Open in sidebar
    </Button>
  );
};
