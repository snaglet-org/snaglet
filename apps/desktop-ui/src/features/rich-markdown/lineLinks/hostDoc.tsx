import { createContext, useContext, type ReactNode } from 'react';

/**
 * The doc an editor is showing, for the chips rendered inside it. A doc chip
 * that points at this same doc with a line or heading anchor jumps there in
 * place instead of opening a preview of the doc the reader is already in.
 */
const HostDocContext = createContext<string | null>(null);

export function HostDocProvider({
  docId,
  children,
}: {
  /** Null for an editor that is not a doc body. */
  docId: string | null;
  children: ReactNode;
}) {
  return <HostDocContext.Provider value={docId}>{children}</HostDocContext.Provider>;
}

/** The id of the doc hosting this render, or null outside a doc body. */
export function useHostDocId(): string | null {
  return useContext(HostDocContext);
}
