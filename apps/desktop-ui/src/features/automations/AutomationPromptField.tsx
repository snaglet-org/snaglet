/**
 * The automation's prompt, on the shared chip editor like the chat composer:
 * `@` finds any doc, thread, table, row or agent, and sidebar nodes drop in.
 * The value is the editor's chip markdown (`[Title](doc-…)`, `@Agent`), the
 * same markup a chat message carries, so the wake's posted message shows the
 * chips. The count is of that stored markup, which is what the server's
 * limit measures.
 */
import { useId } from 'react';
import { AUTOMATION_PROMPT_MAX_LENGTH } from '@snaglet/shared/types';
import { ChipEditableInput } from '@desktop/features/rich-markdown/editor';
import styles from './AutomationChipFields.module.scss';

export interface AutomationPromptFieldProps {
  value: string;
  onChange: (next: string) => void;
  /** Who is told; named in the hint. */
  agentName?: string | null;
  disabled?: boolean;
}

/** Characters the server counts for a prompt (it trims first). */
export const promptLength = (prompt: string): number => prompt.trim().length;

export function AutomationPromptField({
  value,
  onChange,
  agentName,
  disabled = false,
}: AutomationPromptFieldProps) {
  const hintId = useId();
  const length = promptLength(value);
  const over = length > AUTOMATION_PROMPT_MAX_LENGTH;

  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <span className={styles.label}>Prompt</span>
        <span className={styles.count} data-over={over ? 'true' : undefined} aria-live="polite">
          {`${length} / ${AUTOMATION_PROMPT_MAX_LENGTH}`}
        </span>
      </div>
      <div className={styles.shell}>
        <ChipEditableInput
          value={value}
          onChange={onChange}
          multiline
          disabled={disabled}
          placeholder="What should happen at each wake?"
          ariaLabel="Prompt"
          ariaInvalid={over}
          ariaDescribedBy={hintId}
          className={`${styles.input} ${styles.promptInput}`}
        />
      </div>
      <p
        id={hintId}
        className={over ? styles.problem : styles.hint}
        role={over ? 'alert' : undefined}
      >
        {over
          ? `Too long: ${length} of ${AUTOMATION_PROMPT_MAX_LENGTH} characters.`
          : `What ${agentName ?? 'the agent'} is told at each wake. Type @ to link a doc, thread, table or agent, or drag one in.`}
      </p>
    </div>
  );
}
