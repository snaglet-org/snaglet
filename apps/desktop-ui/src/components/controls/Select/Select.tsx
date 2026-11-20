import { forwardRef } from 'react';
import type { SelectHTMLAttributes } from 'react';
import { cn } from '@desktop/utils/classNames';
import styles from './Select.module.scss';

type SelectSize = 'sm' | 'md';

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: SelectSize;
  unstyled?: boolean;
}

const sizeClassMap: Record<SelectSize, string> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ size = 'md', unstyled = false, className, children, disabled, ...rest }, ref) => {
    if (unstyled) {
      return (
        <select ref={ref} className={className} disabled={disabled} {...rest}>
          {children}
        </select>
      );
    }

    // Wrap the native <select> so the leaf caret can live as a masked
    // overlay whose color reads a CSS variable (theme-driven, no hardcoded
    // SVG fill). The <select> stays a real native element,
    // so option list, keyboard nav, and accessibility come for free.
    return (
      <span className={cn(styles.shell, sizeClassMap[size], disabled && styles.disabled)}>
        <select ref={ref} className={cn(styles.select, className)} disabled={disabled} {...rest}>
          {children}
        </select>
        <span className={styles.caret} aria-hidden />
      </span>
    );
  }
);

Select.displayName = 'Select';
