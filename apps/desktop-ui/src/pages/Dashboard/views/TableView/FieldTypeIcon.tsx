import { CheckIcon, PaperclipIcon, TableIcon, TextToolIcon } from '@desktop/components/Icons';

/** A quiet type cue; the surrounding header supplies its accessible description. */
export function FieldTypeIcon({ type }: { type: string }) {
  if (type === 'text' || type.includes('character') || type === 'varchar') return <TextToolIcon />;
  if (type === 'checkbox' || type === 'boolean') return <CheckIcon />;
  if (type === 'relation') return <PaperclipIcon />;
  if (type === 'select')
    return (
      <svg
        viewBox="0 0 24 24"
        width={14}
        height={14}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        focusable="false"
      >
        <path d="M3 5h9l9 9-7 7-11-11V5Z" />
        <circle cx="7.5" cy="8.5" r="1" />
      </svg>
    );
  const temporal = type === 'datetime' || type.startsWith('timestamp');
  const numeric = [
    'number',
    'numeric',
    'integer',
    'bigint',
    'smallint',
    'real',
    'double precision',
  ].includes(type);
  if (!temporal && !numeric && type !== 'date' && type !== 'uuid') return <TableIcon />;
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {type === 'date' ? (
        <>
          <rect x="4" y="5" width="16" height="15" rx="2" />
          <path d="M8 3v4m8-4v4M4 10h16m-12 4h2m4 0h2m-8 3h2" />
        </>
      ) : temporal ? (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 7v5l3 2" />
        </>
      ) : type === 'uuid' ? (
        <>
          <circle cx="8" cy="8" r="4" />
          <path d="m11 11 9 9m-3-3 3-3m-6 0 3-3" />
        </>
      ) : (
        <path d="M10 4 8 20m8-16-2 16M5 9h15M4 15h15" />
      )}
    </svg>
  );
}
