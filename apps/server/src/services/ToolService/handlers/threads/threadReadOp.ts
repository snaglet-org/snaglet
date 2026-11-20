import type { ToolHandler } from '@server/services/ToolService/types';
import messageContext from '@server/services/ToolService/handlers/trivial/messageContext';
import threadRead from '@server/services/ToolService/handlers/trivial/threadRead';

const tool: ToolHandler = async (input, settings, context) =>
  input.mode === 'message_context'
    ? messageContext(input, settings, context)
    : threadRead(input, settings, context);

export default tool;
