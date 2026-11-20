/**
 * Default cap on the total output tokens one user message may produce across
 * every agent that answers it. A runaway guard only: once spent, no further
 * agent or wave is dispatched. It never shortens a single reply, which always
 * asks for the model's own maximum output.
 *
 * Also the server ceiling on that cap (operators may lower it with
 * SNAGLET_MAX_OUTPUT_TOKENS_CEILING), so the default and the ceiling are one value.
 */
export const DEFAULT_CONVERSATION_OUTPUT_TOKENS = 192_000;
