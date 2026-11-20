/**
 * `dispatch` category settings.
 *
 * Two scalars governing the per-agent dispatch caps inside the wave loop:
 *
 *   - `soft_threshold` — over this dispatch count for a single agent, the
 *     system prompt injects a [PASS] nudge.
 *   - `max_agent_dispatches` — hard ceiling for dispatches by a single
 *     agent within a thread.
 *
 * Fresh installs get the registry default of 5.
 *
 * There is no per-thread override: the wave cap already bounds every agent.
 * `dispatchToThreadInternal` reads `softThreshold` unconditionally;
 * `maxAgentDispatches` below is kept as a registry default.
 */

import { z } from 'zod';
import { defineCategory } from '../defineSetting';

const PositiveInt = z.number().int().positive();

export const dispatchSettings = defineCategory('dispatch', {
  softThreshold: {
    key: 'soft_threshold',
    schema: PositiveInt,
    default: 5,
    description:
      'Per-agent dispatch soft threshold. Over this, the system prompt nudges the agent toward [PASS] for the rest of the turn.',
  },
  maxAgentDispatches: {
    key: 'max_agent_dispatches',
    schema: PositiveInt,
    default: 5,
    description:
      'Per-agent dispatch hard ceiling fallback (used when threads.maxAgentDispatches is unset).',
  },
  stagnationSimilarity: {
    key: 'stagnation_similarity',
    schema: z.number().min(0.5).max(1),
    default: 0.93,
    description:
      'Embedding-cosine similarity threshold for repetition (stagnation) detection. ' +
      'A reply this similar to one of the agent’s own recent replies counts as a strike; ' +
      'two consecutive strikes auto-pass the agent. See chatPhases/detectStagnation.ts.',
  },
});
