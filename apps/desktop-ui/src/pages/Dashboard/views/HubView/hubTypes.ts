/**
 * The shapes the Home pane's sections render. HubView builds them from live
 * data; tests and the static previews hand them in directly.
 */

import type { CursorSpec } from '@snaglet/shared/cursor';
import type { DetailSelection } from '../../selection/types';
import type { PinKind } from './hubModel';

export type LoadStatus = 'loading' | 'ready' | 'error';

export type HubSelection = NonNullable<DetailSelection>;

export interface HubAgentFace {
  id: string;
  name: string;
  avatarUrl?: string | null;
  cursorSpec?: CursorSpec | null;
}

export interface HubThreadRow {
  id: string;
  title: string;
  projectName: string | null;
  /** Last message time, else the thread's last change. */
  activityAt: string | null;
  agents: HubAgentFace[];
  /** The last message, once read; null when there is none (or not yet). */
  snippet: { sender: string | null; text: string } | null;
  detailsStatus: LoadStatus;
  pinned: boolean;
  selection: HubSelection;
}

export interface HubDocRow {
  id: string;
  title: string;
  /** Folders and projects above the doc, outermost first. */
  path: string[];
  updatedAt: string;
  pinned: boolean;
  selection: HubSelection;
}

export interface HubPinRow {
  kind: PinKind;
  id: string;
  title: string;
  /** A short second line: the project a thread or table belongs to. */
  meta: string | null;
  /** The item is archived, deleted or otherwise not found. */
  missing: boolean;
  /** Where a click goes; null for a missing item. */
  selection: HubSelection | null;
}

/** Something the "Pin…" picker offers. */
export interface HubPinCandidate {
  kind: PinKind;
  id: string;
  title: string;
  meta: string | null;
}

/** A settings surface that keeps its own pane, linked from Home's Workspace strip. */
export interface HubWorkspaceLink {
  id: string;
  label: string;
  description: string;
  icon: string;
  onOpen: () => void;
}
