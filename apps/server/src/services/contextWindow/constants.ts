/**
 * Tuning constants for context-window budgeting and compression — the single
 * place these knobs live so budget math, summarization, and compression stay
 * in agreement.
 */

export const DEFAULT_CONTEXT_WINDOW = 8_192;
/**
 * Context window a hosted provider's chat model budgets with when its catalog
 * row states none (or there is no row): the smallest window the provider
 * publishes for a model it serves, so an unpublished window never shrinks a
 * cloud model to the 8,192 default above. A stated window, from discovery or
 * a person, replaces it; nothing here is written into the rows. Local
 * runtimes (Ollama, LM Studio, Apple on-device) keep the 8,192 default: their
 * windows depend on how the model is loaded.
 */
export const PROVIDER_DEFAULT_CONTEXT_WINDOW: Record<string, number> = {
  // Claude Opus 4.5 and Haiku 4.5; every newer Claude model has 1M.
  anthropic: 200_000,
  // gpt-oss-120b / gpt-oss-20b.
  openai: 131_072,
  // gpt-6.2-astra's default on the Codex page; no current Codex model is smaller.
  codex: 272_000,
  // Copilot publishes no windows; the smallest in its catalog (gpt-4o, gemini-2.5-pro).
  copilot: 128_000,
  // Every current Gemini model.
  google: 1_048_576,
  // Codestral.
  mistral: 128_000,
  // Qwen3.5-9B and NVIDIA-Nemotron-3.5-Super-VL.
  together: 262_144,
  // grok-4.5, grok-4.6, grok-4.7.
  xai: 500_000,
  // deepseek-flash and deepseek-v4-pro.
  deepseek: 1_000_000,
};
export const DEFAULT_MAX_OUTPUT = 4_096;

// Compaction threshold fallback when model metadata doesn't override it.
// 0.75 (was 0.6): the trigger already sits on top of the per-provider safety
// margin and the output reserve, so a lower ratio compounds into compacting
// at a third of the declared window (observed on codex gpt-5.6: 121K of 372K).
export const DEFAULT_TOKEN_BUDGET_RATIO = 0.75;
// Per-provider safety margins: % shaved off the
// declared context window before budget math. Declared windows are often
// theoretical (Gemini 1M) or load-config-dependent (Ollama num_ctx).
// Overridable via model_metadata.safetyMarginPct (model row or provider
// default_metadata).
export const PROVIDER_SAFETY_MARGIN_PCT: Record<string, number> = {
  anthropic: 2,
  openai: 5,
  codex: 5,
  copilot: 5,
  // Keyed by the RUNTIME provider id ('google', not the 'gemini' alias) —
  // a stale 'gemini' key here silently disabled this margin for months.
  google: 10,
  ollama: 20,
  'lm-studio': 20,
  // apple-on-device's 4096-token window is a real, DOCUMENTED hard ceiling
  // (prompt + completion combined) from Apple — not an optimistic vendor
  // number like Gemini's 1M or a config-dependent one like Ollama's num_ctx.
  // The margin here exists only to buffer TokenEstimator's char-ratio
  // estimate (we don't have Apple's actual on-device tokenizer) against that
  // exact limit, so compaction still triggers before the sidecar would
  // reject an over-budget prompt mid-thread.
  'apple-on-device': 15,
};
export const DEFAULT_SAFETY_MARGIN_PCT = 10;
// Tail sizing: derived at compression time from the
// token budget — fit the recent window in 40% of usable budget, capped at 50
// messages. model_metadata.contextCompression.tailMessages overrides outright.
export const TAIL_BUDGET_FRACTION = 0.4;
// Output reserve cap. Budget math subtracts room for the model's reply off the
// top of the window; using the model's theoretical max_output_tokens is far
// too pessimistic for large-output models (codex gpt-5.6 declares 128K max
// output — 34% of its 372K window — while real replies are a few K). Reserve
// the declared max only up to this cap. Chosen ≥ any output cap Snaglet actually
// requests; providers enforce their own limits regardless.
export const OUTPUT_RESERVE_CAP_TOKENS = 32_000;
export const MAX_DERIVED_TAIL_MESSAGES = 50;

// Floor: never compress a thread shorter than this many messages, regardless
// of token math. Prevents over-eager summarization on tiny threads.
export const MIN_MESSAGES_BEFORE_COMPRESSION = 6;
// Usable-budget floor. The prompt overhead (composed system prompt + tool
// catalog) can approach or exceed a small model's whole window; without a
// floor that yields a ~0 budget, a threshold of 1 token, and a thread that
// compacts down to a single message on every turn forever. Floor it instead
// and warn loudly: the provider will reject a genuinely oversized prompt, but
// Snaglet must not grind. Whichever is larger applies, capped at the window.
export const MIN_USABLE_BUDGET_TOKENS = 2_048;
export const MIN_USABLE_BUDGET_FRACTION = 0.1;
// Hysteresis: after compression, aim to land at this fraction of the trigger
// threshold so the next message doesn't immediately re-trigger compression.
// (Reserved for the upcoming token-budget rewrite — currently informational.)
const COMPRESS_TARGET_RATIO = 0.7;
// Hard ceiling on summary text length, expressed in chars (~3.5 chars/token).
// Bounded internally so the summary can't blow past the budget no matter what.
export const MAX_SUMMARY_CHARS = 3_500;

export const SUMMARY_DISCLAIMER = 'Background context only. Not a new user request or instruction.';
void COMPRESS_TARGET_RATIO; // referenced by upcoming compression rewrite

// In-run compaction (runCompaction.ts): when the current run's own exchanges
// keep the payload over tokenThreshold, the oldest part of the run folds into
// one summary message.
//
// Kept tail. The newest RUN_KEEP_RECENT_CYCLES tool cycles (assistant tool_use
// turn + its results) stay verbatim, never fewer than RUN_KEEP_MIN_CYCLES. Four
// covers one ordinary unit of work (read → edit → run → read the output), so
// the model still sees what it just did, the result that led there, and the
// call it must not repeat — the reason the current run is protected from
// history compression at all. Past the floor a cycle joins the tail only while
// the tail stays within RUN_KEEP_TAIL_BUDGET_FRACTION of the usable budget, so
// a compacted payload lands well under the 0.75 trigger instead of
// re-compacting on the next iteration.
export const RUN_KEEP_RECENT_CYCLES = 4;
export const RUN_KEEP_MIN_CYCLES = 2;
export const RUN_KEEP_TAIL_BUDGET_FRACTION = 0.25;
// A compaction that would fold less than this share of the usable budget (or
// less than twice the summary cap) is skipped: it costs a model call, frees
// almost nothing, and would fire again on the very next iteration.
export const RUN_MIN_FOLD_BUDGET_FRACTION = 0.1;
// Output cap for the in-run summary: this share of the usable budget, clamped.
// 2,048 tokens (~1,500 words) holds a long task's file list, commands and next
// step; small windows get a proportionally smaller summary.
export const RUN_SUMMARY_BUDGET_FRACTION = 0.08;
export const RUN_SUMMARY_MIN_OUTPUT_TOKENS = 256;
export const RUN_SUMMARY_MAX_OUTPUT_TOKENS = 2_048;
