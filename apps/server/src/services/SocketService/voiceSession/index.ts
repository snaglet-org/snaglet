/**
 * voiceSession — voice session + WS protocol + speaking floor (server).
 *
 * Public surface: register the WS handlers (SocketService/index.ts).
 * Everything else is internal to this directory.
 */

export { registerVoiceHandlers } from './handlers';
