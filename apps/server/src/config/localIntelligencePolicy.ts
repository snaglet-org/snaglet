/**
 * Automatic local intelligence is deliberately opt-in. Snaglet's workspace, exact
 * search, and explicit/manual inference remain available without this flag;
 * this policy only governs boot and background model work.
 */
export function isAutomaticLocalIntelligenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SNAGLET_LOCAL_INTELLIGENCE?.trim().toLowerCase() === 'true';
}
