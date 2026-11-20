import type { FC, ReactNode } from 'react';
import { CopyToClipboardButton } from '@desktop/components/CopyToClipboardButton';
import { CheckIcon } from '@desktop/components/Icons';
import styles from './CopyChipButton.module.scss';

export interface CopyChipButtonProps {
  /** Uppercase chip text, e.g. "id" or "path". */
  label: string;
  /** The string copied to the clipboard on click. */
  value: string;
  /** Tooltip while idle. Defaults to `Copy <label>`. */
  idleTitle?: string;
  /** Tooltip after a successful copy. Defaults to `<label> copied!`. */
  copiedTitle?: string;
  /**
   * Optional leading glyph rendered before the label (e.g. a copy icon).
   * When provided, the copied state keeps the label alongside a check so
   * the chip width stays stable. When omitted, the chip is label-only and
   * the copied state shows the bare check icon.
   */
  icon?: ReactNode;
}

/**
 * CopyChipButton — small labeled chip that copies a value to the
 * clipboard. Backs the "ID" / "PATH" chips in the detail-pane topbar and
 * the preview-modal topbar.
 */
export const CopyChipButton: FC<CopyChipButtonProps> = ({
  label,
  value,
  idleTitle,
  copiedTitle,
  icon,
}) => (
  <CopyToClipboardButton
    value={value}
    className={styles.copyButton}
    idleTitle={idleTitle ?? `Copy ${label}`}
    copiedTitle={copiedTitle ?? `${label} copied!`}
    idleContent={
      <>
        {icon}
        <span className={styles.label}>{label}</span>
      </>
    }
    copiedContent={
      icon ? (
        <>
          <CheckIcon />
          <span className={styles.label}>{label}</span>
        </>
      ) : undefined
    }
  />
);
