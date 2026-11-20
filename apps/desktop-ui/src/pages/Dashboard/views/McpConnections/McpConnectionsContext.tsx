import { createContext, useContext, useState, type FC, type ReactNode } from 'react';
import type { McpServer, McpServerUpsert } from '@desktop/utils/api';
import { emitMcpConnectionEvent } from '@desktop/utils/mcpConnectionEvents';
import { ServerEditor } from '../McpView/ServerEditor';
import { useMcp, type UseMcp } from '../McpView/useMcp';
import { useMcpApiKeys, type UseMcpApiKeys } from '../McpServerView/useMcpApiKeys';

type ServerEditorState = { mode: 'add' } | { mode: 'edit'; server: McpServer } | null;

export interface McpConnectionsContextValue {
  clients: UseMcpApiKeys;
  servers: UseMcp;
  openServerEditor: (server?: McpServer) => void;
}

const McpConnectionsContext = createContext<McpConnectionsContextValue | null>(null);

export const McpConnectionsProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const clients = useMcpApiKeys();
  const servers = useMcp();
  const [editor, setEditor] = useState<ServerEditorState>(null);

  const saveServer = async (data: McpServerUpsert): Promise<boolean> => {
    if (!editor) return false;
    if (editor.mode === 'add') return servers.createServer(data);
    const saved = await servers.updateServer(editor.server.id, data);
    if (saved && editor.server.name !== data.name) {
      emitMcpConnectionEvent({
        type: 'server-renamed',
        id: editor.server.id,
        name: data.name,
      });
    }
    return saved;
  };

  return (
    <McpConnectionsContext.Provider
      value={{
        clients,
        servers,
        openServerEditor: (server) => {
          servers.setError(null);
          setEditor(server ? { mode: 'edit', server } : { mode: 'add' });
        },
      }}
    >
      {children}
      {editor && (
        <ServerEditor
          initial={editor.mode === 'edit' ? editor.server : undefined}
          busy={
            editor.mode === 'edit' ? servers.busyId === editor.server.id : servers.busyId !== null
          }
          onClose={() => setEditor(null)}
          onSave={saveServer}
          error={servers.error}
        />
      )}
    </McpConnectionsContext.Provider>
  );
};

export function useMcpConnections(): McpConnectionsContextValue {
  const value = useContext(McpConnectionsContext);
  if (!value) throw new Error('useMcpConnections must be used inside McpConnectionsProvider');
  return value;
}
