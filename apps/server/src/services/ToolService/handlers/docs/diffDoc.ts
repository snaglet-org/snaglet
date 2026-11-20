/**
 * diff_doc — unified line-diff for a doc.
 *
 * Sources supported:
 *   - current doc content vs snapshot                       (doc_id + from_snapshot_id)
 *   - snapshot A vs snapshot B (same doc)                    (from_snapshot_id + to_snapshot_id)
 *   - current doc content vs arbitrary provided content      (doc_id + from_content)
 *
 * Uses an LCS dynamic-program over lines. Capped by max_diff_bytes to avoid
 * pathological inputs.
 */
import type { ToolHandler } from '@server/services/ToolService/types';
import { Docs, getDb } from '@snaglet/db';

interface Input {
  doc_id?: string;
  from_snapshot_id?: string;
  to_snapshot_id?: string;
  from_content?: string;
  context_lines?: number;
  max_diff_bytes?: number;
}

interface SnapshotRow {
  id: string;
  doc_id: string;
  content: string;
  created_at: string | Date;
  label: string | null;
}

// Diff core (LCS table -> ops)
type Op = { kind: '='; line: string } | { kind: '+'; line: string } | { kind: '-'; line: string };

function lcsDiff(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // length table is (n+1) x (m+1)
  const len: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) len[i][j] = len[i + 1][j + 1] + 1;
      else len[i][j] = Math.max(len[i + 1][j], len[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: '=', line: a[i] });
      i++;
      j++;
    } else if (len[i + 1][j] >= len[i][j + 1]) {
      ops.push({ kind: '-', line: a[i] });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: '-', line: a[i++] });
  while (j < m) ops.push({ kind: '+', line: b[j++] });
  return ops;
}

function formatUnifiedDiff(
  ops: Op[],
  fromLabel: string,
  toLabel: string,
  contextLines: number
): { diff: string; added: number; removed: number; hunks: number } {
  // Walk ops, grouping into hunks separated by long runs of equal lines.
  const lines: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let added = 0;
  let removed = 0;
  let hunks = 0;

  // Pre-compute the original line numbers for ops
  let oldNo = 1;
  let newNo = 1;
  const annotated: Array<{ op: Op; oldNo: number; newNo: number }> = ops.map((op) => {
    const r = { op, oldNo, newNo };
    if (op.kind === '=' || op.kind === '-') oldNo++;
    if (op.kind === '=' || op.kind === '+') newNo++;
    return r;
  });

  // Identify change indices
  const changeIdx = annotated
    .map((a, idx) => (a.op.kind === '=' ? -1 : idx))
    .filter((idx) => idx >= 0);
  if (changeIdx.length === 0) {
    return { diff: '', added: 0, removed: 0, hunks: 0 };
  }

  // Group consecutive changes (allowing up to 2*context equal lines between)
  type Hunk = { start: number; end: number };
  const hunkRanges: Hunk[] = [];
  let curStart = Math.max(0, changeIdx[0] - contextLines);
  let curEnd = Math.min(annotated.length - 1, changeIdx[0] + contextLines);
  for (let k = 1; k < changeIdx.length; k++) {
    const c = changeIdx[k];
    const gapStart = Math.max(0, c - contextLines);
    if (gapStart <= curEnd + 1) {
      curEnd = Math.min(annotated.length - 1, c + contextLines);
    } else {
      hunkRanges.push({ start: curStart, end: curEnd });
      curStart = gapStart;
      curEnd = Math.min(annotated.length - 1, c + contextLines);
    }
  }
  hunkRanges.push({ start: curStart, end: curEnd });

  for (const h of hunkRanges) {
    hunks++;
    // header: @@ -oldStart,oldCount +newStart,newCount @@
    const slice = annotated.slice(h.start, h.end + 1);
    const oldStart = slice.find((a) => a.op.kind !== '+')?.oldNo ?? 1;
    const newStart = slice.find((a) => a.op.kind !== '-')?.newNo ?? 1;
    const oldCount = slice.filter((a) => a.op.kind !== '+').length;
    const newCount = slice.filter((a) => a.op.kind !== '-').length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const a of slice) {
      if (a.op.kind === '=') lines.push(` ${a.op.line}`);
      else if (a.op.kind === '+') {
        lines.push(`+${a.op.line}`);
        added++;
      } else {
        lines.push(`-${a.op.line}`);
        removed++;
      }
    }
  }
  return { diff: lines.join('\n'), added, removed, hunks };
}

// Handler
async function loadSnapshot(snapshotId: string): Promise<SnapshotRow> {
  const pool = getDb();
  const res = await pool.query<SnapshotRow>(
    `SELECT id, doc_id, content, created_at, label FROM doc_snapshots WHERE id = $1 LIMIT 1`,
    [snapshotId]
  );
  const row = res.rows[0];
  if (!row) throw new Error(`diff_doc: snapshot not found: ${snapshotId}`);
  return row;
}

const handler: ToolHandler = async (rawInput) => {
  const input = (rawInput ?? {}) as unknown as Input;
  const contextLines =
    typeof input.context_lines === 'number' && Number.isFinite(input.context_lines)
      ? Math.max(0, Math.floor(input.context_lines))
      : 3;
  const maxBytes =
    typeof input.max_diff_bytes === 'number' && Number.isFinite(input.max_diff_bytes)
      ? Math.max(1, Math.floor(input.max_diff_bytes))
      : 200_000;

  // Determine source/destination -----------------------------------------
  if (input.from_snapshot_id && input.from_content !== undefined) {
    throw new Error('diff_doc: pass either `from_snapshot_id` or `from_content`, not both');
  }
  if (!input.from_snapshot_id && input.from_content === undefined) {
    throw new Error('diff_doc: provide either `from_snapshot_id` or `from_content`');
  }

  let fromContent: string;
  let fromLabel: string;
  let toContent: string;
  let toLabel: string;
  let resolvedDocId: string | undefined;

  if (input.from_snapshot_id && input.to_snapshot_id) {
    const fromSnap = await loadSnapshot(input.from_snapshot_id);
    const toSnap = await loadSnapshot(input.to_snapshot_id);
    if (fromSnap.doc_id !== toSnap.doc_id) {
      throw new Error(
        `diff_doc: snapshots belong to different docs (${fromSnap.doc_id} vs ${toSnap.doc_id})`
      );
    }
    if (input.doc_id && input.doc_id !== fromSnap.doc_id) {
      throw new Error(
        `diff_doc: doc_id mismatch (snapshots belong to ${fromSnap.doc_id}, not ${input.doc_id})`
      );
    }
    fromContent = fromSnap.content;
    toContent = toSnap.content;
    fromLabel = `snapshot:${fromSnap.id}`;
    toLabel = `snapshot:${toSnap.id}`;
    resolvedDocId = fromSnap.doc_id;
  } else {
    // need doc_id
    if (!input.doc_id) {
      throw new Error(
        'diff_doc: `doc_id` is required unless you pass both from_snapshot_id and to_snapshot_id'
      );
    }
    const doc = await Docs.findById(input.doc_id);
    if (!doc) throw new Error(`diff_doc: doc not found: ${input.doc_id}`);
    resolvedDocId = doc.id;
    toContent = doc.content ?? '';
    toLabel = `doc:${doc.id}@current`;

    if (input.from_snapshot_id) {
      const snap = await loadSnapshot(input.from_snapshot_id);
      if (snap.doc_id !== doc.id) {
        throw new Error(
          `diff_doc: snapshot ${snap.id} belongs to doc ${snap.doc_id}, not ${doc.id}`
        );
      }
      fromContent = snap.content;
      fromLabel = `snapshot:${snap.id}`;
    } else {
      fromContent = input.from_content ?? '';
      fromLabel = 'provided';
    }
  }

  // Cap size -----------------------------------------------------------------
  const fromBytes = fromContent.length;
  const toBytes = toContent.length;
  if (fromBytes > maxBytes || toBytes > maxBytes) {
    const result = {
      success: true,
      doc_id: resolvedDocId,
      truncated: true,
      from_bytes: fromBytes,
      to_bytes: toBytes,
      max_diff_bytes: maxBytes,
      message: `diff_doc: skipping diff body (from=${fromBytes}B, to=${toBytes}B > max_diff_bytes=${maxBytes}B). Increase max_diff_bytes if you really need it.`,
    };
    return { output: JSON.stringify(result, null, 2), rawContent: result };
  }

  // Diff ---------------------------------------------------------------------
  const fromLines = fromContent === '' ? [] : fromContent.split('\n');
  const toLines = toContent === '' ? [] : toContent.split('\n');
  const ops = lcsDiff(fromLines, toLines);
  const { diff, added, removed, hunks } = formatUnifiedDiff(ops, fromLabel, toLabel, contextLines);

  const identical = diff === '';
  const result = {
    success: true,
    doc_id: resolvedDocId,
    from_label: fromLabel,
    to_label: toLabel,
    from_bytes: fromBytes,
    to_bytes: toBytes,
    identical,
    summary: {
      added_lines: added,
      removed_lines: removed,
      hunks,
    },
    diff: identical ? '' : diff,
    message: identical
      ? `diff_doc: contents identical between ${fromLabel} and ${toLabel}`
      : `diff_doc: ${added} additions, ${removed} removals across ${hunks} hunk(s)`,
  };
  return { output: JSON.stringify(result, null, 2), rawContent: result };
};

export default handler;
