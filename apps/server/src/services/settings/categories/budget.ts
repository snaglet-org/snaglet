/**
 * `budget` category settings.
 *
 * Two profiles, two object settings:
 *
 *   - `group` — applied to multi-agent threads.
 *   - `solo` — applied to single-agent threads. Same shape minus
 *     streamThinking (solo always streams thinking).
 *
 * `conversationTokenBudget` caps the total output of every agent answering
 * one user message: a runaway guard that stops further agents and waves once
 * spent. It never limits a single reply — each request asks for the model's
 * own maximum output. Defaults match docs/architecture.md.
 *
 * The schemas are plain (non-strict) zod objects, which strip unknown keys:
 * a saved row with an unknown key such as `perAgentTokenBudget` still loads.
 */

import { z } from 'zod';
import { DEFAULT_CONVERSATION_OUTPUT_TOKENS } from '@snaglet/shared/constants';
import { defineCategory } from '../defineSetting';

const PositiveInt = z.number().int().positive();

const GroupBudgetSchema = z.object({
  conversationTokenBudget: PositiveInt,
  maxWaves: PositiveInt.nullable(),
  streamThinking: z.boolean(),
});

const SoloBudgetSchema = z.object({
  conversationTokenBudget: PositiveInt,
  maxWaves: PositiveInt.nullable(),
});

export const budgetSettings = defineCategory('budget', {
  group: {
    key: 'group',
    schema: GroupBudgetSchema,
    default: {
      conversationTokenBudget: DEFAULT_CONVERSATION_OUTPUT_TOKENS,
      // No wave cap by default; output-token limits remain enforced.
      maxWaves: null,
      streamThinking: true,
    },
    description: 'Per-conversation budget for group threads (>1 agent participant).',
  },
  solo: {
    key: 'solo',
    schema: SoloBudgetSchema,
    default: {
      conversationTokenBudget: DEFAULT_CONVERSATION_OUTPUT_TOKENS,
      // Match the group profile: no wave cap by default.
      maxWaves: null,
    },
    description: 'Per-conversation budget for solo threads (1 agent participant).',
  },
});
