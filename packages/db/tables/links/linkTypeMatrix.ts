/**
 * Link type-constraint matrix — must stay in sync with the SQL validator
 * `public.link_triple_is_valid`. The SQL validator is deliberately broader
 * than this matrix; keep the deltas in lockstep but do not chase
 * byte-equivalence. Kinds such as 'project', 'task', 'agent', 'block',
 * 'sketch', 'post' and 'discussion' appear in neither.
 *
 * Each entry maps a relation to the (source_type -> allowed target_types) set.
 * Anything not in the matrix is rejected.
 */

import { AppError } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';
import type { LinkRelation } from './LinkModel';

type Matrix = Record<LinkRelation, Record<string, ReadonlyArray<string>>>;

export const LINK_TYPE_MATRIX: Matrix = {
  references: {
    doc: [
      'doc',
      'thread',
      'container',
      'image',
      'memory',
      'thread_summary',
      'tool',
      // A `[label](message-…)` chip cites one chat message.
      'message',
    ],
    // A thread never `references` a message; only doc bodies cite one.
    thread: ['doc', 'thread', 'memory', 'thread_summary'],
  },
  summarizes: {
    thread_summary: ['thread', 'message'],
    memory: ['thread', 'message', 'thread_summary'],
  },
  context: {
    memory: ['thread', 'message', 'thread_summary'],
    thread: ['thread', 'doc'],
    message: ['thread', 'message'],
  },
};

export function isValidLinkTriple(
  sourceType: string,
  relation: string,
  targetType: string
): boolean {
  const rel = LINK_TYPE_MATRIX[relation as LinkRelation];
  if (!rel) return false;
  const allowed = rel[sourceType];
  if (!allowed) return false;
  return allowed.includes(targetType);
}

/** Bad caller input (a 400 at the HTTP edge), not a server fault. */
export class InvalidLinkTripleError extends AppError {
  constructor(sourceType: string, relation: string, targetType: string) {
    super(
      `invalid link triple: (${sourceType}, ${relation}, ${targetType}) is not in the allowed matrix`,
      ErrorCode.VALIDATION_ERROR,
      400
    );
    this.name = 'InvalidLinkTripleError';
    Object.setPrototypeOf(this, InvalidLinkTripleError.prototype);
  }
}
