/**
 * toolResultCondense.ts — Iteration-level tool-result retention (Tier 2/3)
 * for the next API call.
 */

import type { Message } from '../../types';
import type { ToolResultBlock } from '@server/services/ProviderChatService/types';
import { estimateTokens } from '@server/services/TokenEstimator';
import { isRecord } from '@snaglet/shared/utils';
import { extractActionParams } from '@server/services/ToolService/lib/extractActionParams';
import {
  isToolResultError,
  resolveEffectiveToolName,
  summarizeToolResultContent,
  skillLoadMarker,
} from '@server/services/ToolService/toolResultFormat';
import {
  classifyToolCall,
  readSupersedes,
  toolCallHash,
  type MutationScope,
} from '../chatPhases/toolCallTargeting';

export interface CondenseOptions {
  /** Per-result floor: results at/below this length are never condensed. */
  minChars?: number;
  /**
   * Tier 3 pressure threshold — total estimated tokens of retained tool-result
   * content above which the oldest unique results are shed (head+tail). Omit to
   * disable Tier 3; Tier 2 supersede-dedup still runs (it is zero information
   * loss and always on).
   */
  toolBulkBudget?: number;
  /** Estimator inputs, matched to the run's model. */
  provider?: string;
  modelId?: string;
}

/**
 * Iteration-level tool-result retention for the next API call. Only rewrites
 * tool_result content in a copy; never summarizes or reorders turns (that is
 * ContextWindowService.compressMessages). Tier 1 lives in toolDispatch.
 *  - Tier 2, supersede dedup (always on, lossless): when a later read covers an
 *    earlier read of the same target, the earlier copy becomes a one-line pointer.
 *    A read after a write of that target never supersedes the pre-write copy.
 *  - Tier 3, pressure shedding: only above `toolBulkBudget`, head+tail the oldest
 *    unique results, sparing each target's newest copy and the latest tool_result.
 */
export function condenseProcessedToolResults(
  agentMessages: Message[],
  options: CondenseOptions = {}
): Message[] {
  const minChars = options.minChars ?? 300;

  // 1. tool_use id → call metadata; collect mutations in order.
  interface UseMeta {
    toolName: string;
    subject: string | null;
    hash: string;
    fullCoverage: boolean;
  }
  interface WriteEvent {
    msgIdx: number;
    scope: MutationScope;
  }
  const useMeta = new Map<string, UseMeta>();
  const writes: WriteEvent[] = [];

  agentMessages.forEach((m, mi) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    for (const b of m.content as Array<{
      type?: string;
      id?: string;
      name?: unknown;
      input?: unknown;
    }>) {
      if (b.type !== 'tool_use' || typeof b.id !== 'string') continue;
      const effTool =
        resolveEffectiveToolName(b) ?? (typeof b.name === 'string' ? b.name : 'unknown');
      const raw = isRecord(b.input) ? b.input : {};
      const isGateway =
        b.name === 'action' || raw.tool !== undefined || raw.tool_name !== undefined;
      const params = isGateway ? extractActionParams(raw) : raw;
      const cls = classifyToolCall(effTool, params);
      useMeta.set(b.id, {
        toolName: effTool,
        subject: cls.subject,
        hash: toolCallHash(effTool, params),
        fullCoverage: cls.fullCoverage,
      });
      if (cls.mutation) writes.push({ msgIdx: mi, scope: cls.mutation });
    }
  });

  // 2. Most-recent tool_result message index (always protected).
  let lastToolResultIdx = -1;
  for (let i = agentMessages.length - 1; i >= 0; i--) {
    const msg = agentMessages[i];
    if (
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      (msg.content as ToolResultBlock[]).some((b) => b.type === 'tool_result')
    ) {
      lastToolResultIdx = i;
      break;
    }
  }

  // 3. Collect every processed tool_result copy.
  interface Copy {
    msgIdx: number;
    blockIdx: number;
    toolName: string;
    subject: string | null;
    hash: string;
    fullCoverage: boolean;
    content: string;
    isError: boolean;
    len: number;
    processed: boolean;
  }
  const copies: Copy[] = [];
  agentMessages.forEach((msg, mi) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return;
    const blocks = msg.content as ToolResultBlock[];
    if (!blocks.some((b) => b.type === 'tool_result')) return;
    const processed = agentMessages.slice(mi + 1).some((m) => m.role === 'assistant');
    blocks.forEach((block, bi) => {
      if (block.type !== 'tool_result') return;
      const content = block.content;
      if (typeof content !== 'string') return;
      const meta = useMeta.get(block.tool_use_id);
      const toolName = meta?.toolName ?? 'unknown';
      copies.push({
        msgIdx: mi,
        blockIdx: bi,
        toolName,
        subject: meta?.subject ?? null,
        hash: meta?.hash ?? toolCallHash(toolName, content),
        fullCoverage: meta?.fullCoverage ?? true,
        content,
        isError: isToolResultError(content, { toolName, isError: block.is_error }),
        len: content.length,
        processed,
      });
    });
  });

  const overrides = new Map<string, string>();
  const supersededKeys = new Set<string>();
  const keyOf = (c: Copy) => `${c.msgIdx}:${c.blockIdx}`;

  const sameTarget = (a: Copy, b: Copy): boolean =>
    a.subject !== null && b.subject !== null ? a.subject === b.subject : a.hash === b.hash;

  // Was `subject` mutated by a write landing in (loMsg, hiMsg]? Then copies
  // straddling it are different generations and must not be deduped.
  const invalidatedBetween = (subject: string | null, loMsg: number, hiMsg: number): boolean =>
    writes.some(
      (w) =>
        w.msgIdx > loMsg &&
        w.msgIdx <= hiMsg &&
        (w.scope.scope === 'all' ||
          (subject !== null && w.scope.scope === 'subject' && w.scope.subject === subject))
    );

  // Tier 2: supersede dedup (always on).
  for (const a of copies) {
    if (a.isError || !a.processed || a.msgIdx === lastToolResultIdx) continue;
    const supersededBy = copies.find(
      (b) =>
        b.msgIdx > a.msgIdx &&
        sameTarget(a, b) &&
        readSupersedes({ hash: b.hash, fullCoverage: b.fullCoverage }, { hash: a.hash }) &&
        !invalidatedBetween(a.subject, a.msgIdx, b.msgIdx)
    );
    if (!supersededBy) continue;
    // A superseded skill load gets the same fixed marker as a condensed one.
    const pointer = skillLoadMarker(a.content) ?? buildSupersededPointer(a.toolName, a.len);
    if (pointer.length >= a.len) continue; // never grow a tiny result
    overrides.set(keyOf(a), pointer);
    supersededKeys.add(keyOf(a));
  }

  // Tier 3: pressure shedding vs the tool-bulk token budget (rare).
  const provider = options.provider ?? 'anthropic';
  const budget = options.toolBulkBudget;
  const contentFor = (c: Copy): string => overrides.get(keyOf(c)) ?? c.content;
  const tokensOf = (text: string) => estimateTokens(text, provider, options.modelId);

  if (budget !== undefined) {
    let retained = copies.reduce((sum, c) => sum + tokensOf(contentFor(c)), 0);
    if (retained > budget) {
      // Newest-per-target protection: for a target read more than once, its
      // newest copy is never shed (older copies are already Tier-2 pointers).
      const bySubject = new Map<string, Copy[]>();
      for (const c of copies) {
        if (!c.subject) continue;
        const arr = bySubject.get(c.subject);
        if (arr) arr.push(c);
        else bySubject.set(c.subject, [c]);
      }
      const protectedKeys = new Set<string>();
      for (const [, list] of bySubject) {
        if (list.length > 1) {
          const newest = list.reduce((mx, c) => (c.msgIdx > mx.msgIdx ? c : mx));
          protectedKeys.add(keyOf(newest));
        }
      }
      const candidates = copies
        .filter(
          (c) =>
            !supersededKeys.has(keyOf(c)) &&
            !protectedKeys.has(keyOf(c)) &&
            c.msgIdx !== lastToolResultIdx &&
            c.processed &&
            !c.isError &&
            c.len > minChars
        )
        .sort((x, y) => x.msgIdx - y.msgIdx || x.blockIdx - y.blockIdx);
      for (const c of candidates) {
        if (retained <= budget) break;
        const condensed = summarizeToolResultContent(c.content, {
          toolName: c.toolName,
          onError: 'keep',
          isError: c.isError,
        });
        const saved = tokensOf(c.content) - tokensOf(condensed);
        if (saved <= 0) continue;
        overrides.set(keyOf(c), condensed);
        retained -= saved;
      }
    }
  }

  if (overrides.size === 0) return agentMessages;

  return agentMessages.map((msg, mi) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    const blocks = msg.content as ToolResultBlock[];
    if (!blocks.some((b) => b.type === 'tool_result')) return msg;
    let changed = false;
    const newBlocks = blocks.map((block, bi) => {
      if (block.type !== 'tool_result') return block;
      const ov = overrides.get(`${mi}:${bi}`);
      if (ov === undefined) return block;
      changed = true;
      return { ...block, content: ov };
    });
    return changed ? ({ ...msg, content: newBlocks } as Message) : msg;
  });
}

/** One-line pointer left in place of a superseded (older, fully-covered) copy. */
function buildSupersededPointer(toolName: string, originalLen: number): string {
  return (
    `[superseded read of \`${toolName}\` — a later read of the same target this run holds the ` +
    `current content (kept in full below); ${originalLen} chars omitted here to avoid duplication.]`
  );
}
