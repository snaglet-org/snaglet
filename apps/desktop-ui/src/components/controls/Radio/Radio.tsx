import { createContext, forwardRef, useContext, type ReactNode } from 'react';
import styles from './Radio.module.scss';
import { cn } from '@desktop/utils/classNames';

type RadioSize = 'sm' | 'md';

interface RadioGroupContextValue {
  name: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  size: RadioSize;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

function useRadioGroupContext(): RadioGroupContextValue {
  const ctx = useContext(RadioGroupContext);
  if (!ctx) {
    throw new Error('<Radio> must be rendered inside a <RadioGroup> parent.');
  }
  return ctx;
}

export interface RadioGroupProps {
  value: string;
  onChange: (next: string) => void;
  /**
   * Shared `name` for the underlying native radios. Browsers use this to
   * enforce single-select within the group when the radios live in the
   * same form. Falls back to a stable random id when omitted.
   */
  name?: string;
  disabled?: boolean;
  size?: RadioSize;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
  children: ReactNode;
}

let radioGroupCounter = 0;

export const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(
  (
    {
      value,
      onChange,
      name,
      disabled,
      size = 'md',
      className,
      children,
      'aria-label': ariaLabel,
      'aria-labelledby': ariaLabeledBy,
    },
    ref
  ) => {
    const resolvedName = name ?? `radiogroup-${++radioGroupCounter}`;

    return (
      <RadioGroupContext.Provider value={{ name: resolvedName, value, onChange, disabled, size }}>
        <div
          ref={ref}
          role="radiogroup"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabeledBy}
          className={cn(styles.group, className)}
        >
          {children}
        </div>
      </RadioGroupContext.Provider>
    );
  }
);

RadioGroup.displayName = 'RadioGroup';

export interface RadioProps {
  value: string;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  children?: ReactNode;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(
  (
    { value, description, disabled: disabledProp, className, children, 'aria-label': ariaLabel },
    ref
  ) => {
    const {
      name,
      value: activeValue,
      onChange,
      disabled: groupDisabled,
      size,
    } = useRadioGroupContext();
    const isChecked = activeValue === value;
    const disabled = disabledProp ?? groupDisabled ?? false;

    return (
      <label
        className={cn(
          styles.option,
          size === 'sm' ? styles.sizeSm : styles.sizeMd,
          isChecked && styles.optionChecked,
          disabled && styles.disabled,
          className
        )}
      >
        <input
          ref={ref}
          type="radio"
          name={name}
          value={value}
          checked={isChecked}
          disabled={disabled}
          aria-label={ariaLabel}
          onChange={(e) => {
            if (e.target.checked) onChange(value);
          }}
          className={styles.input}
        />
        <span className={styles.dot} aria-hidden="true" />
        {(children !== undefined || description !== undefined) && (
          <span className={styles.body}>
            {children !== undefined && <span className={styles.label}>{children}</span>}
            {description !== undefined && <span className={styles.description}>{description}</span>}
          </span>
        )}
      </label>
    );
  }
);

Radio.displayName = 'Radio';
