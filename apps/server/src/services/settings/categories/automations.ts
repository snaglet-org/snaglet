/**
 * `automations` category settings: the limits on scheduled agent wakes.
 * Written only from Settings and the other human routes; agents have
 * no tool for them.
 */

import { z } from 'zod';
import { defineCategory } from '../defineSetting';

const PositiveInt = z.number().int().positive();

export const automationSettings = defineCategory('automations', {
  maxActivePerAgent: {
    key: 'max_active_per_agent',
    schema: PositiveInt.max(1000),
    default: 10,
    description: 'Most active automations one agent may have at a time.',
  },
  maxCreatedPerRun: {
    key: 'max_created_per_run',
    schema: PositiveInt.max(100),
    default: 3,
    description: 'Most automations an agent may create in one run.',
  },
  agentMinIntervalMinutes: {
    key: 'agent_min_interval_minutes',
    schema: PositiveInt.max(10_080),
    default: 15,
    description: 'Shortest "every" interval an agent may set, in minutes (people: 1 minute).',
  },
  missedRunGraceMinutes: {
    key: 'missed_run_grace_minutes',
    schema: PositiveInt.max(10_080),
    default: 60,
    description:
      'A wake missed while Snaglet was off still runs once when it is at most this many minutes late; older ones are skipped.',
  },
  failuresBeforePause: {
    key: 'failures_before_pause',
    schema: PositiveInt.max(100),
    default: 3,
    description: 'Consecutive failed wakes after which an automation pauses itself.',
  },
  agentRunsPerHour: {
    key: 'agent_runs_per_hour',
    schema: PositiveInt.max(100),
    default: 3,
    description:
      'Most times an agent may run one of its automations now (a test wake) in an hour; people have no limit.',
  },
});
