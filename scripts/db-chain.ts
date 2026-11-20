/**
 * Root wrapper for the two chained db commands:
 *
 *   pnpm db:migrate [--target=<dev|preview|prod|external>] [--dry-run]
 *     migrations, then the built-in tool catalog sync
 *   pnpm db:init    [--target=...] [--dry-run] [--with-reranker]
 *     init, then the embedder model fetch. The reranker is off by default
 *     (feature flag `reranker`), so its model is fetched only with
 *     --with-reranker.
 *
 * Every step that writes to the database runs the db-script target guard,
 * so each one must get the same --target / --dry-run. A plain
 * `a && b` package script would append extra args to the last command only.
 * Later steps are skipped when an earlier one fails or refuses, and on
 * --dry-run.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WITH_RERANKER = '--with-reranker';

export interface ChainPlan {
  steps: string[][];
  /** How many leading steps receive `args` (the db-script target guard args). */
  dbStepCount: number;
  args: string[];
}

/** The pnpm steps a db command runs, or null for an unknown command. */
export function planChain(
  command: string | undefined,
  rawArgs: readonly string[]
): ChainPlan | null {
  const args = rawArgs.filter((arg) => arg !== '--');
  if (command === 'migrate') {
    return {
      steps: [
        ['--filter', '@snaglet/db', 'run', 'migrate'],
        ['--filter', '@snaglet/server', 'run', 'sync:tool', '--all'],
      ],
      dbStepCount: 2,
      args,
    };
  }
  if (command === 'init') {
    const withReranker = args.includes(WITH_RERANKER);
    return {
      steps: [
        ['--filter', '@snaglet/db', 'run', 'init'],
        ...(withReranker ? [['reranker:fetch']] : []),
        ['embedder:fetch'],
      ],
      dbStepCount: 1,
      args: args.filter((arg) => arg !== WITH_RERANKER),
    };
  }
  return null;
}

function run(command: string, pnpmArgs: string[]): number {
  const result = spawnSync('pnpm', pnpmArgs, { stdio: 'inherit', env: process.env });
  if (result.error) {
    console.error(`[db:${command}] could not start pnpm: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function chain(command: string, plan: ChainPlan): number {
  const dryRun = plan.args.includes('--dry-run');
  for (const [index, step] of plan.steps.entries()) {
    if (dryRun && index >= 1) {
      console.error(`[db:${command}] dry run: skipping the remaining steps.`);
      return 0;
    }
    const status = run(command, index < plan.dbStepCount ? [...step, ...plan.args] : step);
    if (status !== 0) return status;
  }
  return 0;
}

function main(): void {
  const [command, ...rawArgs] = process.argv.slice(2);
  const plan = planChain(command, rawArgs);
  if (!command || !plan) {
    console.error(
      'Usage: tsx scripts/db-chain.ts <migrate|init> [--target=...] [--dry-run] [--with-reranker]'
    );
    process.exitCode = 1;
    return;
  }
  if (command === 'init' && !plan.steps.some((step) => step[0] === 'reranker:fetch')) {
    console.log(
      '[db:init] Not fetching the reranker model: reranking is off by default (feature flag ' +
        '`reranker`). After turning it on, run `pnpm reranker:fetch`.'
    );
  }
  process.exitCode = chain(command, plan);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
