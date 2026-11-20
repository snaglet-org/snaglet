/**
 * Longest text the workspace owner can save as instructions for all agents
 * (Home's Instructions card, setting `agent.global_instructions`). The text rides in
 * every agent's system prompt, so the cap keeps that prefix bounded.
 */
export const AGENT_GLOBAL_INSTRUCTIONS_MAX_LENGTH = 8000;
