import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { defaultPillSelection, type SpeakerMessage } from './pillSelection';

export interface ThreadRecipientContextValue {
  participantAgentIds: string[];
  selectedAgentIds: string[];
  toggleAgent: (agentId: string) => void;
  agentName: (agentId: string) => string;
}

const ThreadRecipientContext = createContext<ThreadRecipientContextValue | null>(null);

export interface ThreadRecipientProviderProps {
  threadId: string;
  messages: ReadonlyArray<SpeakerMessage>;
  participantAgentIds: string[];
  agentNameById: Map<string, string>;
  children: ReactNode;
}

/**
 * Thread-scoped recipient selection shared by typed and voice sends.
 *
 * Until the user changes a pill, selection follows the last participating
 * agent who spoke. Once touched, it stays user-controlled and only removes
 * agents that leave the thread. An empty selection is intentional: typed
 * sends remain unaddressed (the server surfaces its existing dispatch hint in
 * `mentioned` mode), while voice keeps its existing server-side default.
 */
export function ThreadRecipientProvider({
  threadId,
  messages,
  participantAgentIds,
  agentNameById,
  children,
}: ThreadRecipientProviderProps) {
  const participantsKey = participantAgentIds.join(',');
  const defaultSelection = useMemo(
    () => defaultPillSelection(messages, participantAgentIds),
    [messages, participantAgentIds]
  );
  const [touched, setTouched] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>(defaultSelection);

  useEffect(() => {
    setTouched(false);
  }, [threadId]);

  useEffect(() => {
    if (!touched) setSelectedAgentIds(defaultSelection);
  }, [defaultSelection, touched]);

  useEffect(() => {
    setSelectedAgentIds((previous) =>
      previous.filter((agentId) => participantAgentIds.includes(agentId))
    );
  }, [participantsKey]);

  const toggleAgent = useCallback(
    (agentId: string) => {
      if (!participantAgentIds.includes(agentId)) return;
      setTouched(true);
      setSelectedAgentIds((previous) =>
        previous.includes(agentId)
          ? previous.filter((selectedId) => selectedId !== agentId)
          : [...previous, agentId]
      );
    },
    [participantAgentIds]
  );

  const agentName = useCallback(
    (agentId: string) => agentNameById.get(agentId) ?? agentId.slice(0, 8),
    [agentNameById]
  );

  const value = useMemo<ThreadRecipientContextValue>(
    () => ({ participantAgentIds, selectedAgentIds, toggleAgent, agentName }),
    [participantAgentIds, selectedAgentIds, toggleAgent, agentName]
  );

  return (
    <ThreadRecipientContext.Provider value={value}>{children}</ThreadRecipientContext.Provider>
  );
}

export function useThreadRecipientContext(): ThreadRecipientContextValue | null {
  return useContext(ThreadRecipientContext);
}
