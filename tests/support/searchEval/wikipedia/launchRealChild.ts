import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { assertSafeRealEmbeddingChildEnv, type RealEmbeddingChildEnv } from '../safety';

export const WIKIPEDIA_REAL_TIMEOUT_MS = 10 * 60 * 1000;
type ChildOutput = { stdout: string; stderr: string };
type ExecuteChild = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: RealEmbeddingChildEnv;
    timeout: number;
    maxBuffer: number;
  }
) => Promise<ChildOutput>;

/** No database imports: validate the inherited disposable harness before spawning. */
export async function runOptionalWikipediaRealChild(
  env: RealEmbeddingChildEnv = process.env,
  execute: ExecuteChild = promisify(execFile)
): Promise<ChildOutput | null> {
  if (env.SNAGLET_SEARCH_EVAL_REAL_EMBEDDINGS !== '1') return null;
  assertSafeRealEmbeddingChildEnv(env);
  try {
    return await execute(
      process.execPath,
      [
        path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
        path.resolve(process.cwd(), 'tests/support/searchEval/wikipedia/realEmbeddingChild.ts'),
      ],
      {
        cwd: process.cwd(),
        env: { ...env },
        timeout: WIKIPEDIA_REAL_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      }
    );
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `Real Wikipedia evaluation child failed: ${[failure.stdout, failure.stderr].filter(Boolean).join('\n') || failure.message}`,
      { cause: error }
    );
  }
}
