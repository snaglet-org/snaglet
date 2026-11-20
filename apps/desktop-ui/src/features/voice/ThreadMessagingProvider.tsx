import type { ReactNode } from 'react';
import {
  ThreadRecipientProvider,
  type ThreadRecipientProviderProps,
} from './ThreadRecipientContext';
import { VoiceSessionProvider } from './VoiceSessionContext';

type ThreadMessagingProviderProps = Omit<ThreadRecipientProviderProps, 'children'> & {
  children: ReactNode;
};

/** Compose thread recipients with voice as one ChatView-level boundary. */
export function ThreadMessagingProvider({
  threadId,
  messages,
  participantAgentIds,
  agentNameById,
  children,
}: ThreadMessagingProviderProps) {
  return (
    <ThreadRecipientProvider
      threadId={threadId}
      messages={messages}
      participantAgentIds={participantAgentIds}
      agentNameById={agentNameById}
    >
      <VoiceSessionProvider threadId={threadId}>{children}</VoiceSessionProvider>
    </ThreadRecipientProvider>
  );
}
