import { type CSSProperties, type FC } from 'react';
import { defaultCursorSpec, type CursorSpec } from '@snaglet/shared/cursor';
import { FlowerAvatar } from '@desktop/components/agentCursor/FlowerAvatar';
import styles from './DmAvatar.module.scss';

/** One side of a DM conversation, as far as its avatar needs to know. */
export type DmAvatarParty =
  | {
      kind: 'agent';
      agentId: string;
      cursorSpec?: CursorSpec | null;
      avatarUrl?: string | null;
    }
  | { kind: 'user'; name: string };

interface DmAvatarProps {
  party: DmAvatarParty;
  /** Edge length in px. */
  size?: number;
}

/**
 * The avatar beside an agent's name in a DM: its uploaded picture or its
 * generated flower (as in the Agents roster). The user has none (see
 * PartyName). Decorative: the name always sits next to it.
 */
export const DmAvatar: FC<DmAvatarProps> = ({ party, size = 28 }) => {
  const style = { '--dm-avatar-size': `${size}px` } as CSSProperties;
  // The person gets no avatar: the name carries a muted "(you)" instead.
  if (party.kind === 'user') return null;
  return (
    <span
      className={`${styles.avatar} ${party.avatarUrl ? styles.picture : ''}`}
      style={style}
      data-testid="dm-avatar"
      data-kind="agent"
      aria-hidden
    >
      {party.avatarUrl ? (
        <img src={party.avatarUrl} alt="" className={styles.img} />
      ) : (
        <FlowerAvatar
          spec={party.cursorSpec ?? defaultCursorSpec(party.agentId)}
          emotion="neutral"
          size={size}
          animate={false}
        />
      )}
    </span>
  );
};
