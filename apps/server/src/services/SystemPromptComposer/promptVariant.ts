/**
 * promptVariant — the eval runner's seam for comparing a candidate core prompt
 * (C) against the shipped one (B) on the same live turn.
 *
 * A variant is a list of find/replace edits applied to the RENDERED system
 * blocks, so a candidate file is literally the prompt diff under test and
 * everything else (role text, owner instructions, tools, skills, the turn
 * context tail) stays byte-identical between the arms.
 *
 * Gated exactly like the scripted provider: a variant is honored only when
 * `NODE_ENV === 'test'` or `SNAGLET_ENABLE_PROMPT_VARIANTS=1`. A production server
 * never reads one, so this file cannot change what real agents are sent.
 *
 * Every edit must match exactly once in the rendered core. A miss throws:
 * a candidate that silently fails to apply would make C indistinguishable
 * from B and report a false "no difference".
 */

import { logger } from '@server/config/logger';
import type { SystemContentBlock } from './types';

interface PromptVariantEdit {
  /** Exact text in the rendered system prompt (must occur exactly once). */
  find: string;
  /** Replacement ("" deletes). */
  replace: string;
}

export interface PromptVariant {
  /** Short id recorded with every trial, e.g. `C-long-work-rule`. */
  id: string;
  edits: PromptVariantEdit[];
}

let active: PromptVariant | null = null;

let warnedOutsideTest = false;

/**
 * Warn once per process when the gate is open only because of the env flag
 * (i.e. outside tests), so a production server never runs with prompt variants
 * enabled by accident. Fires on first use of the gate, which every compose hits.
 */
function warnIfEnabledOutsideTest(): void {
  if (warnedOutsideTest) return;
  warnedOutsideTest = true;
  logger.warn(
    '[SystemPromptComposer] SNAGLET_ENABLE_PROMPT_VARIANTS=1 is set outside tests: prompt variants ' +
      'are enabled and may alter the system prompt sent to agents. Unset it unless you are ' +
      'running the prompt-eval runner.'
  );
}

/** Test-only: re-arm the one-time warning. */
export function resetPromptVariantWarningForTests(): void {
  warnedOutsideTest = false;
}

/** True when a variant may be installed or applied at all. */
export function promptVariantsEnabled(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.SNAGLET_ENABLE_PROMPT_VARIANTS === '1') {
    warnIfEnabledOutsideTest();
    return true;
  }
  return false;
}

/** Install the variant for subsequent composes (null restores baseline B). */
export function setPromptVariant(variant: PromptVariant | null): void {
  if (variant && !promptVariantsEnabled()) {
    throw new Error(
      'Prompt variants are test-only (NODE_ENV=test or SNAGLET_ENABLE_PROMPT_VARIANTS=1).'
    );
  }
  active = variant;
}

export function getPromptVariant(): PromptVariant | null {
  return promptVariantsEnabled() ? active : null;
}

/**
 * Apply `variant` to rendered system blocks. Pure: returns new blocks, never
 * mutates the input. Throws when an edit matches zero or several times across
 * all blocks (an edit never spans two blocks).
 */
export function applyPromptVariant(
  blocks: SystemContentBlock[],
  variant: PromptVariant
): SystemContentBlock[] {
  const out = blocks.map((block) => ({ ...block }));
  for (const [index, edit] of variant.edits.entries()) {
    if (!edit.find) throw new Error(`variant ${variant.id} edit ${index}: empty find`);
    const hits: number[] = [];
    out.forEach((block, i) => {
      const count = block.text.split(edit.find).length - 1;
      for (let n = 0; n < count; n++) hits.push(i);
    });
    if (hits.length !== 1) {
      throw new Error(
        `variant ${variant.id} edit ${index}: expected 1 match, found ${hits.length} for ${JSON.stringify(edit.find.slice(0, 60))}`
      );
    }
    const target = out[hits[0]!]!;
    target.text = target.text.replace(edit.find, () => edit.replace);
  }
  return out;
}
