import { registerAgentListHandler } from './handlers/agentHandlers';
import {
  registerChatAbortHandler,
  registerChatSendHandler,
  registerAskSyncHandler,
  registerClarificationResponseHandler,
  registerToolConfirmHandler,
} from './handlers/chatHandlers';
import { registerSessionHandlers } from './handlers/sessionHandlers';
import { initLiveRunStatuses } from './handlers/chatHelpers/agentStatusEvents';
import { registerThreadCompactHandler } from './handlers/compactHandlers';
import { registerVoiceHandlers } from './voiceSession';
import { registerVisionHandlers } from './visionSession';
import { logger } from '@server/config/logger';

class SocketService {
  init(): void {
    logger.info('[socket] Initializing socket relay (provider adapters)');

    initLiveRunStatuses();
    registerSessionHandlers();
    registerChatSendHandler();
    registerToolConfirmHandler();
    registerClarificationResponseHandler();
    registerAskSyncHandler();
    registerChatAbortHandler();
    registerAgentListHandler();
    registerThreadCompactHandler();
    registerVoiceHandlers();
    registerVisionHandlers();

    logger.info(
      '[socket] Handlers registered: session:create, session:resume, chat:send, chat:abort, tool:confirm, asks:sync, agents:list, thread:compact, voice:*, vision:*'
    );
  }
}

export const socketService = new SocketService();
