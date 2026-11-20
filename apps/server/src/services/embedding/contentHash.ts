import { createHash } from 'crypto';

export function normalizeEmbeddingContent(text: string | null | undefined): string {
  return (text ?? '').trim();
}

export function embeddingContentHash(text: string | null | undefined): string {
  return createHash('sha256').update(normalizeEmbeddingContent(text)).digest('hex');
}

/**
 * Raw-body sha256 for file content — the content-addressing key shared by the
 * files table (ingest writes it to files.content_hash) and file_embeddings.
 * Deliberately not normalized: it must equal the hash of the exact on-disk
 * bytes so the ingest row and the embedding key can never disagree. Text files
 * pass the decoded utf-8 body (byte-identical to the file); extractable files
 * (PDF) pass the raw Buffer — the binary file itself is the identity, its
 * extracted text is derived.
 */
export function fileBodyHash(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export function estimateEmbeddingTokens(text: string | null | undefined): number {
  const normalized = normalizeEmbeddingContent(text);
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}
