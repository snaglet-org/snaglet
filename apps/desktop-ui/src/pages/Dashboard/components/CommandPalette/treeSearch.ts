import {
  AGENT_ID_PREFIX,
  idPrefixAlternation,
  LEGACY_ID_PREFIX,
  NODE_KIND,
} from '@snaglet/shared/constants/nodeKinds';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { labelOf, type Kind } from './paletteResultMappers';

/**
 * Returns true when the query looks like a bare node ID
 * (e.g. "task-1780088587092-pp0bo1z09", "doc-178...", "container-178...").
 * We match a known kind prefix followed by digits and an optional alphanumeric
 * suffix so that partial IDs like "task-178" also resolve.
 */
const NODE_ID_RE = new RegExp(
  `^(${idPrefixAlternation([
    LEGACY_ID_PREFIX.TASK,
    NODE_KIND.DOC,
    NODE_KIND.THREAD,
    NODE_KIND.MESSAGE,
    NODE_KIND.CONTAINER,
    NODE_KIND.MEMORY,
    NODE_KIND.THREAD_SUMMARY,
    NODE_KIND.TOOL,
    AGENT_ID_PREFIX,
  ])})-`,
  'i'
);

function looksLikeNodeId(query: string): boolean {
  return NODE_ID_RE.test(query.trim());
}

/** Flatten the workspace tree into a simple list (recursive). */
export function flatten(nodes: LibraryTreeChild[]): LibraryTreeChild[] {
  const out: LibraryTreeChild[] = [];
  for (const node of nodes) {
    out.push(node);
    if (node.kind === 'container' && node.children?.length) {
      out.push(...flatten(node.children));
    }
  }
  return out;
}

/**
 * Fuzzy score of `query` against `label` (both already lowercased) — the VS
 * Code Cmd+P "Go to File" mental model, so a roughly-typed name jumps to the
 * doc/thread/container. Higher is better; `null` means no match.
 *
 *   - A substring match is the strongest tier (score ≥ 2); an earlier position
 *     and a word-boundary start rank higher.
 *   - Otherwise every query char must appear in order as a subsequence; a more
 *     contiguous run and an earlier first hit rank higher (tier < 2).
 *   - No subsequence ⇒ `null`.
 *
 * Deterministic and dependency-free (no fuse.js) so the palette's instant,
 * client-side pass over the cached node list stays instant.
 */
export function fuzzyScore(label: string, query: string): number | null {
  if (!query) return 0;
  const idx = label.indexOf(query);
  if (idx >= 0) {
    const prev = idx === 0 ? '' : label[idx - 1];
    const atBoundary = idx === 0 || /[^a-z0-9]/i.test(prev ?? '');
    return 2 + (atBoundary ? 0.5 : 0) - idx / (label.length + 1);
  }
  // Subsequence walk: consume query chars in order, counting contiguous runs.
  let qi = 0;
  let runs = 0;
  let inRun = false;
  let firstMatch = -1;
  for (let li = 0; li < label.length && qi < query.length; li++) {
    if (label[li] === query[qi]) {
      if (firstMatch < 0) firstMatch = li;
      if (!inRun) {
        runs++;
        inRun = true;
      }
      qi++;
    } else {
      inRun = false;
    }
  }
  if (qi < query.length) return null;
  // Fewer runs ⇒ more contiguous ⇒ better; earlier first hit ⇒ better. Score
  // stays in (1, 2), strictly below the substring tier's 2+.
  const contiguity = 1 / runs; // (0, 1]
  return 1 + contiguity - firstMatch / (label.length + 1);
}

export function treeHitsFor(
  nodes: LibraryTreeChild[],
  trimmedTerm: string,
  kinds: Kind[] | null
): LibraryTreeChild[] {
  const lc = trimmedTerm.toLowerCase();
  const isId = looksLikeNodeId(trimmedTerm);
  // Score every kind-eligible node, then rank best-first so a rough name jumps
  // to its target. Substring matches lead (fuzzyScore tier ≥ 2); subsequence
  // matches fill in below.
  const scored: Array<{ node: LibraryTreeChild; score: number }> = [];
  for (const node of nodes) {
    // Projects are containers (category='project') and surface as ordinary
    // container hits. Task ids belong to docs, so a pasted `task-…` id
    // matches via the node-id prefix below.
    if (kinds && !kinds.includes(node.kind)) continue;
    if (!trimmedTerm) {
      scored.push({ node, score: 0 });
      continue;
    }
    if (isId && node.id.toLowerCase().startsWith(lc)) {
      scored.push({ node, score: Number.POSITIVE_INFINITY });
      continue;
    }
    const score = fuzzyScore(labelOf(node).toLowerCase(), lc);
    if (score !== null) scored.push({ node, score });
  }
  // Stable sort (V8): equal scores keep tree order, so the empty-term case still
  // returns every node in its original order.
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.node);
}
