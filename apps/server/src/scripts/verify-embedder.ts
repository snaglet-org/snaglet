/**
 * verify-embedder — end-to-end check of the local ONNX embedder.
 *
 * Runs the real model (requires `pnpm embedder:fetch` first) and asserts the
 * output contract: 768 dimensions, unit norm, task prefixes applied (document
 * vs query of identical text differ), and sane semantic ordering. Prints a
 * JSON report on success; exits non-zero with the failed assertion otherwise.
 *
 * Exists as a standalone script (not a jest test) because onnxruntime-node's
 * tensor type checks reject typed arrays created in jest's sandboxed VM realm
 * — the unit suite shells out to this instead (LocalEmbedderService.test.ts).
 *
 * Usage: pnpm embedder:verify
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '@snaglet/shared/utils';
import { loadModelFetchEnvironment } from './modelFetchEnvironment';
import {
  embedDocument,
  embedQuery,
  getLocalEmbedderStatus,
} from '../services/embedding/LocalEmbedderService';
import { LOCAL_EMBEDDER_DIMENSIONS } from '../services/embedding/embedderModelManifest';

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function cos(a: number[], b: number[]): number {
  return a.reduce((s, x, i) => s + x * b[i]!, 0);
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

async function main(): Promise<void> {
  loadModelFetchEnvironment(dirname(fileURLToPath(import.meta.url)));
  const status = await getLocalEmbedderStatus();
  assert(status.ready, `embedder not ready: ${status.error ?? 'unknown'}`);

  const text = 'The quick brown fox jumps over the lazy dog.';
  const doc = await embedDocument(text);
  const query = await embedQuery(text);
  const related = await embedQuery('a fast fox leaping above a sleepy canine');
  const unrelated = await embedQuery('quarterly financial report for the accounting team');

  const report = {
    dimensions: doc.length,
    docNorm: Number(norm(doc).toFixed(6)),
    queryNorm: Number(norm(query).toFixed(6)),
    cosSameTextDocVsQuery: Number(cos(doc, query).toFixed(4)),
    cosRelated: Number(cos(doc, related).toFixed(4)),
    cosUnrelated: Number(cos(doc, unrelated).toFixed(4)),
  };

  assert(report.dimensions === LOCAL_EMBEDDER_DIMENSIONS, `dims ${report.dimensions} != 768`);
  assert(Math.abs(report.docNorm - 1) < 1e-4, `doc norm ${report.docNorm} != 1`);
  assert(Math.abs(report.queryNorm - 1) < 1e-4, `query norm ${report.queryNorm} != 1`);
  // Prefix contract: identical text through the two methods must differ …
  assert(report.cosSameTextDocVsQuery < 0.999, 'doc/query vectors identical — prefixes missing');
  // … while remaining strongly related (same content).
  assert(report.cosSameTextDocVsQuery > 0.5, 'doc/query vectors unrelated — pipeline broken');
  assert(report.cosRelated > report.cosUnrelated, 'semantic ordering wrong');

  console.log(JSON.stringify({ ok: true, ...report }));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: getErrorMessage(err) }));
    process.exit(1);
  });
