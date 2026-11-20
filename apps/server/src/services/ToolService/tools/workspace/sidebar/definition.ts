import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import { SIDEBAR_TAB_ALIASES, SIDEBAR_TAB_IDS } from '@snaglet/shared/types';

const definition: BuiltinToolDefinition = {
  id: 'sidebar',
  name: 'Sidebar',
  type: 'builtin',
  tier: 'core',
  sort_order: 911,
  description:
    "Control the user's native Snaglet sidebar. open optionally selects a tab; close preserves the selected tab; status reads it. inspect returns mounted Workspace, Agents, Calendar, Providers, Tools, Skills or Automations rows (Automations lists timed automations and scripts; not backend inventory); closed/unmounted and unsupported tabs are explicit. scroll glides the open tab's list to top/bottom or centers an inspect target over duration_ms (default 600, max 10000) without moving the mouse, replying after it finishes with scroll_top, scroll_height, client_height and at_bottom. Returns confirmed open and active_tab from the live UI, or a structured failure. Does not change panes.",
  keywords: ['sidebar', 'activity bar', 'open', 'close', 'status', 'scroll', 'ui'],
  parameters_schema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['open', 'close', 'status', 'inspect', 'expand', 'collapse', 'resize', 'scroll'],
      },
      width_px: {
        type: 'number',
        description:
          'resize only: finite CSS pixels; clamps to native sidebar limits 200–560 px and persists through the existing width preference. Does not open or switch tabs.',
      },
      target: {
        type: 'string',
        description:
          'expand/collapse/scroll: opaque target from inspect (scroll: exclusive with to; centers the row). Workspace containers and mounted disclosure rows/groups in Calendar, Providers, Tools, Skills and Automations; unsupported tabs fail explicitly. Handles are mount-scoped: re-inspect after changing tabs. Does not select, navigate, enable, run or edit.',
      },
      to: {
        type: 'string',
        enum: ['top', 'bottom'],
        description:
          'scroll only: exclusive with target. Scrolls the active tab list to its top or bottom.',
      },
      duration_ms: {
        type: 'number',
        description:
          'scroll only: eased animation length in ms, default 600, clamped 0–10000. The reply arrives after it finishes.',
      },
      tab: {
        type: 'string',
        enum: [...SIDEBAR_TAB_IDS, ...Object.keys(SIDEBAR_TAB_ALIASES)],
        description:
          'open only. Omit to retain the selected tab. hooks is an alias that opens automations, where scripts are listed.',
      },
    },
    required: ['op'],
    additionalProperties: false,
  },
};
export default definition;
