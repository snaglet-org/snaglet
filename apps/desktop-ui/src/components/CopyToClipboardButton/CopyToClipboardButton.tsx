import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from '@desktop/components/Icons';

export interface CopyToClipboardButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'title'
> {
  value: string;
  idleTitle?: string;
  copiedTitle?: string;
  idleContent?: React.ReactNode;
  copiedContent?: React.ReactNode;
  copiedDurationMs?: number;
  stopPropagation?: boolean;
  onCopySuccess?: () => void;
  onCopyError?: (error: unknown) => void;
}

export const CopyToClipboardButton: React.FC<CopyToClipboardButtonProps> = ({
  value,
  idleTitle = 'Copy',
  copiedTitle = 'Copied!',
  idleContent = <CopyIcon />,
  copiedContent = <CheckIcon />,
  copiedDurationMs = 1500,
  stopPropagation = false,
  onClick,
  onCopySuccess,
  onCopyError,
  type = 'button',
  ...buttonProps
}) => {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleClick = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      if (stopPropagation) {
        event.stopPropagation();
      }

      onClick?.(event);
      if (event.defaultPrevented) {
        return;
      }

      try {
        if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
          throw new Error('Clipboard API is not available');
        }

        await navigator.clipboard.writeText(value);
        setCopied(true);
        onCopySuccess?.();

        if (timeoutRef.current !== null) {
          window.clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = window.setTimeout(() => setCopied(false), copiedDurationMs);
      } catch (error) {
        onCopyError?.(error);
      }
    },
    [copiedDurationMs, onClick, onCopyError, onCopySuccess, stopPropagation, value]
  );

  return (
    <button
      {...buttonProps}
      type={type}
      onClick={handleClick}
      title={copied ? copiedTitle : idleTitle}
    >
      {copied ? copiedContent : idleContent}
    </button>
  );
};
