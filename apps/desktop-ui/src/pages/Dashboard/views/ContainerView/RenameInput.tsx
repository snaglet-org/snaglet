import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

interface RenameInputProps {
  initialValue: string;
  className?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/** Inline rename input used by IconCell / ListRow. Enter commits, Escape cancels, blur commits. */
export const RenameInput: FC<RenameInputProps> = ({
  initialValue,
  className,
  onCommit,
  onCancel,
}) => {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Guards against double-commit when blur fires right after Enter.
  const committedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(value);
  };

  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => setValue(e.target.value);

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <input
      ref={inputRef}
      className={className}
      value={value}
      onChange={onChange}
      onKeyDown={onKey}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onDragStart={(e) => e.preventDefault()}
      spellCheck={false}
      aria-label="New name"
    />
  );
};
