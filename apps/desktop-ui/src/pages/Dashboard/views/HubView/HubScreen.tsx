import { type FC } from 'react';
import { HubHeader, type HubHeaderProps } from './HubHeader';
import { InstructionsCard, type InstructionsCardProps } from './InstructionsCard';
import { PinnedSection, type PinnedSectionProps } from './PinnedSection';
import {
  RecentDocsSection,
  RecentThreadsSection,
  type RecentDocsSectionProps,
  type RecentThreadsSectionProps,
} from './RecentSections';
import { WorkspaceStrip, type WorkspaceStripProps } from './WorkspaceStrip';
import styles from './HubView.module.scss';

export interface HubScreenProps {
  header: HubHeaderProps;
  pinned: PinnedSectionProps;
  threads: RecentThreadsSectionProps;
  docs: RecentDocsSectionProps;
  instructions: InstructionsCardProps;
  workspace: WorkspaceStripProps;
}

/**
 * The Home pane's layout, data in hand. The greeting and Pinned sit beside
 * the small instructions card; under them the two recent lists (threads and
 * docs) share the rest of the pane's height, each scrolling inside itself; the Workspace links close the page. In a narrow pane everything
 * stacks and the page scrolls. HubView feeds it live data; tests and
 * previews feed it directly.
 */
export const HubScreen: FC<HubScreenProps> = ({
  header,
  pinned,
  threads,
  docs,
  instructions,
  workspace,
}) => (
  <div className={styles.shell} data-testid="hub-view">
    <div className={styles.page}>
      <div className={styles.top}>
        <div className={styles.topMain}>
          <HubHeader {...header} />
          <PinnedSection {...pinned} />
        </div>
        <InstructionsCard {...instructions} />
      </div>
      <div className={styles.lists}>
        <RecentThreadsSection {...threads} />
        <RecentDocsSection {...docs} />
      </div>
      <WorkspaceStrip {...workspace} />
    </div>
  </div>
);
