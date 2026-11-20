import { type ComponentType, type FC } from 'react';
import {
  AgentsViewIcon,
  AutomationsViewIcon,
  WorkspaceTreeIcon,
  SettingsViewIcon,
  ToolsViewIcon,
  SkillsViewIcon,
  ProvidersViewIcon,
  McpViewIcon,
} from '@desktop/components/Icons';
import { Tabs, Tooltip } from '@desktop/components';
import { SwirlSpin } from '@desktop/features/automations/RunningSwirl';
import { CalendarIcon } from '@desktop/features/calendar/CalendarIcon';
import { type SidebarViewId } from './views';
import styles from './ActivityBar.module.scss';

interface ActivityBarItem {
  id: SidebarViewId;
  label: string;
  Icon: ComponentType;
}

const ACTIVITY_BAR_ITEMS: ActivityBarItem[] = [
  { id: 'library', label: 'Workspace', Icon: WorkspaceTreeIcon },
  { id: 'calendar', label: 'Calendar', Icon: CalendarIcon },
  { id: 'agents', label: 'Agents', Icon: AgentsViewIcon },
  { id: 'providers', label: 'Providers', Icon: ProvidersViewIcon },
  { id: 'tools', label: 'Tools', Icon: ToolsViewIcon },
  { id: 'skills', label: 'Skills', Icon: SkillsViewIcon },
  { id: 'automations', label: 'Automations', Icon: AutomationsViewIcon },
  { id: 'mcp', label: 'MCP', Icon: McpViewIcon },
  { id: 'settings', label: 'Settings', Icon: SettingsViewIcon },
];

interface ActivityBarProps {
  active: SidebarViewId;
  onSelect: (id: SidebarViewId) => void;
  /**
   * Views with work going on, with a short note (e.g. `{ automations: '1
   * running' }`): the view's glyph spins and the note joins its label.
   */
  activity?: Partial<Record<SidebarViewId, string>>;
}

/**
 * ActivityBar — VS-Code-style vertical toggle column. Each button
 * switches the view panel to the matching sidebar view. The currently
 * active view is highlighted with a brand-colored left accent bar.
 */
export const ActivityBar: FC<ActivityBarProps> = ({ active, onSelect, activity }) => {
  const items = ACTIVITY_BAR_ITEMS;
  return (
    <Tabs
      className={styles.root}
      orientation="vertical"
      variant="rail"
      value={active}
      onChange={(next) => onSelect(next as SidebarViewId)}
      aria-label="Sidebar views"
    >
      {items.map(({ id, label, Icon }) => {
        const note = activity?.[id];
        const fullLabel = note ? `${label} · ${note}` : label;
        // Chat-bubble tooltip opens inward (to the right) from the edge rail.
        // `aria-label` stays on the tab for screen readers; the native `title`
        // is dropped so the OS tooltip doesn't double up with the bubble.
        return (
          <Tooltip key={id} label={fullLabel} side="right">
            <Tabs.Tab value={id} aria-label={fullLabel}>
              {note ? (
                <SwirlSpin spinning>
                  <Icon />
                </SwirlSpin>
              ) : (
                <Icon />
              )}
            </Tabs.Tab>
          </Tooltip>
        );
      })}
    </Tabs>
  );
};
