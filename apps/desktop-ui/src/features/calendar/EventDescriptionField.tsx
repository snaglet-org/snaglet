/**
 * An event's description on the shared chip editor, like the chat composer
 * and the automation prompt: `@` quick-searches any doc, thread, table, row
 * or agent, and sidebar nodes drag in as chips. The stored value is the
 * editor's chip markdown (`[Title](doc-…)`), plain text otherwise. Enter
 * adds a line; Cmd/Ctrl+Enter submits when the host has a submit.
 */
import { CALENDAR_EVENT_DESCRIPTION_MAX_LENGTH } from '@snaglet/shared/types';
import { ChipEditableInput } from '@desktop/features/rich-markdown/editor';
import styles from './CalendarPopovers.module.scss';

interface EventDescriptionFieldProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  autoFocus?: boolean;
}

export function EventDescriptionField({
  value,
  onChange,
  onSubmit,
  autoFocus,
}: EventDescriptionFieldProps) {
  return (
    <div className={styles.descriptionShell}>
      <ChipEditableInput
        multiline
        autoFocus={autoFocus}
        value={value}
        onChange={(next) => onChange(next.slice(0, CALENDAR_EVENT_DESCRIPTION_MAX_LENGTH))}
        onSubmit={onSubmit}
        placeholder="Add description, or @ to link a doc, row or agent"
        ariaLabel="Description"
        className={styles.descriptionInput}
      />
    </div>
  );
}
