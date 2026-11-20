/**
 * Test double for `ChipEditableInput` (the real one mounts TipTap, which is
 * heavy and irrelevant to most callers' behavior). A plain textarea that
 * honors the props callers rely on: value/onChange, aria label, placeholder,
 * disabled, autoFocus, and the real editor's submit keys — single-line: Enter
 * submits; multiline: Cmd/Ctrl+Enter submits, and bare Enter too with
 * `submitOnEnter` (Shift+Enter still breaks the line).
 * Only imported from `*.test.tsx` files via `vi.mock` factories.
 */

import type { FC } from 'react';
import type { ChipEditableInputProps } from '@desktop/features/rich-markdown/editor/chipEditableInput.types';

export const MockChipEditableInput: FC<ChipEditableInputProps> = ({
  value,
  onChange,
  placeholder,
  disabled,
  autoFocus,
  ariaLabel,
  onSubmit,
  multiline,
  submitOnEnter,
  richBlocks,
  enableNodeMentions,
}) => (
  <textarea
    aria-label={ariaLabel}
    placeholder={placeholder}
    value={value}
    disabled={disabled}
    autoFocus={autoFocus}
    data-rich-editor="true"
    data-multiline={multiline ? 'true' : 'false'}
    data-submit-on-enter={submitOnEnter ? 'true' : 'false'}
    data-rich-blocks={richBlocks ? 'true' : 'false'}
    data-node-mentions={enableNodeMentions ? 'true' : 'false'}
    onChange={(event) => onChange(event.target.value)}
    onKeyDown={(event) => {
      if (event.key !== 'Enter') return;
      const mod = event.metaKey || event.ctrlKey;
      const submits = !multiline || mod || (submitOnEnter && !event.shiftKey);
      if (!submits) return;
      event.preventDefault();
      onSubmit?.();
    }}
  />
);
