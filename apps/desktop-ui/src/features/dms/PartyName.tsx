import { type FC } from 'react';
import styles from './PartyName.module.scss';

interface PartyNameProps {
  name: string;
  /** True when this party is the signed-in person. */
  isYou?: boolean;
}

/** A DM party's name; the person's own gets a muted "(you)" after it. */
export const PartyName: FC<PartyNameProps> = ({ name, isYou = false }) => (
  <>
    {name}
    {isYou ? <span className={styles.you}> (you)</span> : null}
  </>
);
