import {
  AgentsViewIcon,
  ContainerIcon,
  DocIcon,
  ChatBubbleIcon,
  ImageIcon,
  ListGlyph,
  TableIcon,
  ToolIcon,
} from '@desktop/components/Icons';
import styles from './CommandPalette.module.scss';

// Accepts a bare `string` (not just PaletteNodeKind) so a stale/deleted kind
// reaching this component renders a neutral fallback glyph instead of nothing.
export function KindIcon({ kind }: { kind: string }) {
  switch (kind) {
    case 'container':
      return <ContainerIcon />;
    case 'doc':
      return <DocIcon />;
    case 'thread':
      return <ChatBubbleIcon />;
    case 'message':
      return <ChatBubbleIcon />;
    case 'memory':
      return (
        <span className={styles.taskDot} aria-hidden>
          ◇
        </span>
      );
    case 'thread_summary':
      return <DocIcon />;
    case 'image':
      return <ImageIcon />;
    case 'tool':
      return <ToolIcon />;
    case 'agent':
      return <AgentsViewIcon />;
    case 'table':
      return <TableIcon />;
    case 'entry':
      return <ListGlyph />;
    default:
      // Unknown / deleted kind — neutral fallback, never crash.
      return <DocIcon />;
  }
}
