import type { TableSelectOptionColor } from '@snaglet/shared/types';
import { cn } from '@desktop/utils/classNames';
import styles from './SelectOptionTag.module.scss';

const colorClasses: Record<TableSelectOptionColor, string> = {
  blue: styles.blue,
  green: styles.green,
  yellow: styles.yellow,
  orange: styles.orange,
  red: styles.red,
  purple: styles.purple,
  pink: styles.pink,
  brown: styles.brown,
  gray: styles.gray,
};

/** Shared tint and readable foreground, without tag geometry, for settings swatches. */
export function selectOptionColorClass(color: TableSelectOptionColor = 'gray'): string {
  return cn(styles.palette, colorClasses[color] ?? colorClasses.gray);
}

interface SelectOptionTagProps {
  label: string;
  color?: TableSelectOptionColor;
  className?: string;
}

/** Presentation only: the cell, picker or settings row owns interaction. */
export function SelectOptionTag({ label, color, className }: SelectOptionTagProps) {
  return (
    <span className={cn(styles.tag, selectOptionColorClass(color), className)} title={label}>
      <span className={styles.label}>{label}</span>
    </span>
  );
}
