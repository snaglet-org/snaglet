import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  RERANKER_MODEL_MANIFEST,
  expandHome,
  hfDownloadUrl,
  modelFileAbsPath,
} from '@server/services/reranking/rerankerModelManifest';

/**
 * The fetch script downloads to the paths in the manifest; the runtime resolver
 * reads the paths + sha256 from the seeded catalog row. If these drift, the
 * model lands somewhere the resolver doesn't look (or fails its checksum). These
 * tests bind the manifest to the seed so they can never silently diverge.
 */

const SEED_PATH = path.resolve(
  __dirname,
  '../../../../../../packages/db/migrations/seeds/local-models.sql'
);

interface SeedRerankingMeta {
  modelFile: string;
  vocabFile: string;
  tokenizerConfigFile: string;
  sha256: string;
}

function readSeedRerankingMeta(): SeedRerankingMeta {
  const sql = readFileSync(SEED_PATH, 'utf8');
  // The metadata is embedded as a single-quoted ::jsonb literal with nested
  // braces, which is awkward to JSON-parse out of the surrounding SQL. The
  // seed file carries both the embedder ("embedding") and reranker
  // ("reranking") metadata blocks with the same key names, so scope the
  // extraction to the reranking block (it appears exactly once).
  const rerankingStart = sql.indexOf('"reranking"');
  if (rerankingStart < 0) throw new Error('seed metadata is missing the "reranking" block');
  const rerankingSql = sql.slice(rerankingStart);
  const value = (key: string): string => {
    const match = rerankingSql.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
    if (!match) throw new Error(`seed metadata is missing "${key}"`);
    return match[1];
  };
  return {
    modelFile: value('modelFile'),
    vocabFile: value('vocabFile'),
    tokenizerConfigFile: value('tokenizerConfigFile'),
    sha256: value('sha256'),
  };
}

describe('reranker model manifest', () => {
  const seed = readSeedRerankingMeta();
  const fileByLocalPath = (suffix: string) => {
    const file = RERANKER_MODEL_MANIFEST.files.find((f) => f.localPath === suffix);
    if (!file) throw new Error(`manifest is missing ${suffix}`);
    return file;
  };

  it('writes the ONNX model to the exact path + checksum the resolver reads', () => {
    const onnx = fileByLocalPath('onnx/model_qint8_arm64.onnx');
    expect(modelFileAbsPath(onnx)).toBe(expandHome(seed.modelFile));
    expect(onnx.sha256).toBe(seed.sha256);
  });

  it('writes the vocab + tokenizer config to the resolver paths', () => {
    expect(modelFileAbsPath(fileByLocalPath('vocab.txt'))).toBe(expandHome(seed.vocabFile));
    expect(modelFileAbsPath(fileByLocalPath('tokenizer_config.json'))).toBe(
      expandHome(seed.tokenizerConfigFile)
    );
  });

  it('pins an immutable 40-hex commit and 64-hex sha256s', () => {
    expect(RERANKER_MODEL_MANIFEST.hf.revision).toMatch(/^[0-9a-f]{40}$/);
    for (const file of RERANKER_MODEL_MANIFEST.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.bytes).toBeGreaterThan(0);
    }
  });

  it('builds pinned Hugging Face resolve URLs', () => {
    const onnx = fileByLocalPath('onnx/model_qint8_arm64.onnx');
    expect(hfDownloadUrl(onnx)).toBe(
      `https://huggingface.co/${RERANKER_MODEL_MANIFEST.hf.repo}/resolve/${RERANKER_MODEL_MANIFEST.hf.revision}/onnx/model_qint8_arm64.onnx`
    );
  });
});
