/**
 * threadSummaryPrompts — plain-text prompt templates for thread-summary
 * generation (never demand JSON/structured output — small local models
 * fail it). Two flavors:
 *
 * - STANDARD: the full narrative-memory instruction set.
 * - SIMPLE: a short imperative version used for the one retry after a
 *   quality-floor failure — small models follow terse instructions better.
 */

export const THREAD_SUMMARY_INSTRUCTIONS =
  'You maintain the running memory of a conversation between a user and one or more agents. ' +
  'Summarize ONLY the messages you are given; earlier parts of the conversation are covered elsewhere. ' +
  'Write a concise narrative summary in plain prose — no JSON, no code fences, no headings. ' +
  'Preserve who said what, decisions made, action items with owners, unresolved questions, and ' +
  'any constraints or preferences stated. Prefer concrete facts over commentary. ' +
  'Aim for under 600 words. Output ONLY the summary text.';

export const SIMPLE_THREAD_SUMMARY_INSTRUCTIONS =
  'Summarize the conversation below in 3 to 8 plain sentences. ' +
  'State the main topic, any decisions, and the next steps. ' +
  'Write only the summary text, nothing else.';

/**
 * A digest section: the messages since the last digest, and only those. The previous digest is
 * never part of the prompt; the result is appended to it (summary/digestSections).
 */
export function buildFreshThreadSummaryPrompt(formatted: string, messageCount: number): string {
  return `CONVERSATION (${messageCount} messages):\n${formatted}`;
}

/** Agent-perspective block appended to the system instructions. */
export function buildAgentPerspectiveBlock(agentRole: string): string {
  return (
    `\n\nIMPORTANT: This summary is for an agent with the following role:\n${agentRole}\n` +
    `Emphasize information most relevant to this agent's responsibilities. ` +
    `Still capture the key decisions and context in these messages, but prioritize details this agent needs.`
  );
}
