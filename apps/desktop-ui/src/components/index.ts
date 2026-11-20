export { ErrorBoundary } from './ErrorBoundary/ErrorBoundary';

// Layout primitives — the shared spacing/rhythm grammar every pane composes.
export { Stack, Cluster, Section, DisclosureSection } from './layout';

export { Button } from './controls';

export { Checkbox } from './controls';
export { OptionToggle, OptionToggleRow } from './controls';
export type { CheckboxModifiers } from './controls';
export {
  DEFAULT_SEARCH_CHANNELS,
  SearchModeControl,
  type SearchChannels,
} from './SearchModeControl';

export { Chip } from './Chip';
export type { ChipTone } from './Chip';

export { CopyChipButton } from './CopyChipButton';

export { CopyToClipboardButton } from './CopyToClipboardButton';

export { DateInput } from './controls';

export { EmptyState } from './EmptyState';

export { Light } from './controls';

export { Modal } from './Modal';

// Overlay behavior primitive — the single dismiss/focus contract for anything
// that opens. Prefer this over hand-rolled pointerdown/Escape listeners.
export { Popover, usePopover, useDismissable } from './Popover';

export { Radio, RadioGroup } from './controls';

export { Select } from './controls';

export { Segmented } from './Segmented';

export { Spinner } from './Spinner';

export { Switch } from './controls';

export { Tabs } from './Tabs';

export { Tooltip } from './Tooltip/Tooltip';

export { HelpTooltip } from './Tooltip/HelpTooltip';

export { Textarea } from './controls';

export { TextInput } from './controls';

export { ToastHost } from './Toast';
export { WsStatusIndicator } from './WsStatusIndicator/WsStatusIndicator';

export { StatusBar, StatusBarProvider, ConnectionHealthSlot } from './StatusBar';
