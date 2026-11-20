/**
 * Claude limits by model generation, for a model whose catalog row or list
 * entry states none. Claude 4.6 and later (every 5.x included) have a 1M
 * context window and a 128K output cap; Opus 4.5 and Haiku 4.5 have 200K and
 * 64K; the older families have smaller caps.
 */

/** Major and minor version of a Claude id (`claude-opus-4-5-20251101` is 4.5), or null. */
function claudeVersion(modelId: string): { major: number; minor: number } | null {
  const tokens = modelId
    .replace(/\[[^\]]*\]$/, '')
    .split('-')
    .filter((token) => /^\d{1,2}$/.test(token));
  if (tokens.length === 0) return null;
  return { major: Number(tokens[0]), minor: Number(tokens[1] ?? 0) };
}

function isCurrentGeneration(modelId: string): boolean {
  const version = claudeVersion(modelId);
  if (!version) return false;
  return version.major >= 5 || (version.major === 4 && version.minor >= 6);
}

/** Context window of a Claude model by generation. */
export function anthropicContextWindow(modelId: string): number {
  if (/(?:-|\[)1m\]?$/i.test(modelId) || isCurrentGeneration(modelId)) return 1_000_000;
  return 200_000;
}

/** Output cap of a Claude model by generation. */
export function anthropicMaxOutput(modelId: string): number {
  if (isCurrentGeneration(modelId)) return 128_000;
  if (/(?:opus|haiku)-4-5/.test(modelId)) return 64_000;
  if (/opus-4/.test(modelId)) return 32_000;
  if (/sonnet-4/.test(modelId)) return 16_000;
  return 8_192;
}
