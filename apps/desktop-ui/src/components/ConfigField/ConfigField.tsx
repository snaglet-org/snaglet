import type { FC, ReactNode } from 'react';
import styles from '../AgentConfigCard/parts.module.scss';

interface ConfigFieldProps {
  label: string;
  children: ReactNode;
  inherited?: boolean;
  overridden?: boolean;
}

export const ConfigField: FC<ConfigFieldProps> = ({ label, children, inherited, overridden }) => (
  <div className={styles.configField}>
    <label className={styles.configFieldLabel}>
      {label}
      {inherited && <InheritancePillInline source="inherited" />}
      {overridden && <InheritancePillInline source="overridden" />}
    </label>
    {children}
  </div>
);

function InheritancePillInline({ source }: { source: 'inherited' | 'overridden' }) {
  const cls =
    source === 'inherited' ? styles.inheritancePillInherited : styles.inheritancePillOverridden;
  return <span className={`${styles.inheritancePill} ${cls}`}>{source}</span>;
}
