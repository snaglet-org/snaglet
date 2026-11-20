/**
 * A reply that stops at the model's output limit (`max_tokens`): how one is
 * recognized across providers, the one continuation the turn loop asks for,
 * and the thread notice when the reply still ends cut off. Thinking models
 * spend output tokens on thinking first, so a limit set too low ends the
 * reply before any visible text.
 */

/**
 * Stop reasons meaning the reply was cut off before it finished: Anthropic
 * (`max_tokens`, `model_context_window_exceeded`), Chat Completions
 * (`length`), Responses (`max_output_tokens`), Gemini (`MAX_TOKENS`, mapped
 * to `max_tokens`).
 */
const OUTPUT_LIMIT_STOP_REASONS = new Set([
  'max_tokens',
  'length',
  'max_output_tokens',
  'model_context_window_exceeded',
]);

export function isOutputLimitStop(stopReason: string | undefined): boolean {
  return stopReason !== undefined && OUTPUT_LIMIT_STOP_REASONS.has(stopReason);
}

/** The next user turn after a cut-off reply, sent at most once per run. */
export const OUTPUT_LIMIT_CONTINUE_PROMPT =
  'Your last reply stopped at the output limit before it was finished. Continue from where ' +
  'it stopped without repeating what you already wrote. If you had not started your answer ' +
  'yet, give it now, and keep it short.';

/**
 * What the thread shows when a reply ends at the output limit: the limit the
 * request carried, or the provider's own when the request named none.
 */
export function outputLimitNotice(maxOutputTokens: number | null): string {
  const limit =
    maxOutputTokens === null
      ? "this model's output limit"
      : `this model's output limit (${maxOutputTokens.toLocaleString('en-US')} tokens)`;
  return (
    `The reply stopped at ${limit} before it was finished. Ask the agent to continue, ` +
    'or raise Max output for this model in Providers.'
  );
}
