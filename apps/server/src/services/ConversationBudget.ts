/**
 * ConversationBudget — tracks token and iteration spend across an entire
 * conversation turn (all agents combined) and enforces safety limits.
 *
 * The output-token pool is a runaway backstop and a dispatch gate: once spent,
 * no further agent or wave starts. It never sizes a request — every model call
 * asks for the model's own maximum output, so no reply is cut short by it.
 *
 * Owns THE wave counter for the dispatch loop:
 * `dispatchToThreadInternal` increments waves here and reads
 * `currentWave()` — there is no parallel counter. `maxTotalOutputTokens`
 * arrives already clamped by `buildConversationBudget` (`min(threadOverride
 * ?? settingsDefault, serverCeiling)` — see `groupChat/safety.ts`), so it is
 * always finite. `maxWaves` is the one EXCEPTION, and deliberately so: a
 * thread override of `null` passes through as
 * `Number.POSITIVE_INFINITY` — genuinely unbounded, no ceiling clamp. Runaway
 * safety in that case comes entirely from `maxTotalOutputTokens`, which
 * still applies unconditionally.
 */

export interface ConversationBudgetConfig {
  /** Max total output tokens across all agents per user message. */
  maxTotalOutputTokens: number;
  /**
   * Max dispatch waves per conversation. Finite in the common case
   * (ceiling-clamped only via the settings default; no server ceiling
   * clamps an explicit override) or `Number.POSITIVE_INFINITY` when the
   * thread has "No limit" set.
   */
  maxWaves: number;
}

/**
 * Consumption carried over from an ended run into its self-healing redispatch
 * (undelivered mid-run messages, reaped runs). The redispatch CONTINUES the
 * conversation, so it continues the conversation's spend — a fresh budget per
 * redispatch would let a wedge-redispatch cycle sidestep every limit.
 */
export interface ConversationBudgetSeed {
  waves: number;
  totalOutputTokens: number;
}

export interface BudgetSummary {
  totalOutputTokens: number;
  waves: number;
  exhaustedReason: string | null;
}

export class ConversationBudget {
  private totalOutputTokens = 0;
  private waveCount = 0;

  private maxTotalOutputTokens: number;
  private maxWaves: number;

  constructor(config: ConversationBudgetConfig, seed?: ConversationBudgetSeed) {
    this.maxTotalOutputTokens = config.maxTotalOutputTokens;
    this.maxWaves = config.maxWaves;
    if (seed) {
      this.waveCount = Math.max(0, seed.waves);
      this.totalOutputTokens = Math.max(0, seed.totalOutputTokens);
    }
  }

  /** Record output tokens from a completed agent turn. */
  recordAgentTurn(outputTokens: number): void {
    this.totalOutputTokens += outputTokens;
  }

  /** Increment the wave counter. Call at the start of each dispatch wave. */
  incrementWave(): void {
    this.waveCount++;
  }

  /**
   * True once the wave limit is reached: the wave that would start next must
   * not start. Checked explicitly at the top of the dispatch loop so the stop
   * is attributable as a wave-cap ending (distinct from token exhaustion).
   */
  waveLimitReached(): boolean {
    return this.waveCount >= this.maxWaves;
  }

  /**
   * True once a NON-wave budget dimension (output tokens) is exhausted. This
   * is the mid-wave gate: a wave that was already admitted may finish its
   * dispatched turns, but must not start new ones (mention wakes, all-mode
   * fan-out, sequential continuation) once the real spend limits are gone.
   * Wave count is deliberately excluded — the wave limit only governs
   * STARTING waves, at the loop top.
   */
  exhaustedNonWave(): boolean {
    return this.nonWaveExhaustionKind() !== null;
  }

  /** Which spend dimension is exhausted, as a stop reason — null when none. */
  nonWaveExhaustionKind(): 'token-budget' | null {
    if (this.totalOutputTokens >= this.maxTotalOutputTokens) return 'token-budget';
    return null;
  }

  /** Check whether the conversation can continue (no limits exhausted). */
  canContinue(): boolean {
    return !this.waveLimitReached() && !this.exhaustedNonWave();
  }

  /** Current wave number (1-indexed; 0 before the first wave starts). */
  currentWave(): number {
    return this.waveCount;
  }

  /** The effective wave limit (may be `Number.POSITIVE_INFINITY`), for logging/UI. */
  waveLimit(): number {
    return this.maxWaves;
  }

  /** Snapshot for seeding a continuation redispatch (see ConversationBudgetSeed). */
  seedSnapshot(): ConversationBudgetSeed {
    return {
      waves: this.waveCount,
      totalOutputTokens: this.totalOutputTokens,
    };
  }

  /** Summary for logging at conversation end. */
  summary(): BudgetSummary {
    let exhaustedReason: string | null = null;
    if (this.waveLimitReached()) {
      exhaustedReason = `max waves (${this.maxWaves})`;
    } else if (this.totalOutputTokens >= this.maxTotalOutputTokens) {
      exhaustedReason = `output token budget (${this.maxTotalOutputTokens})`;
    }

    return {
      totalOutputTokens: this.totalOutputTokens,
      waves: this.waveCount,
      exhaustedReason,
    };
  }
}
