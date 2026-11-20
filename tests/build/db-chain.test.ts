import assert from 'node:assert/strict';
import test from 'node:test';
import { planChain } from '../../scripts/db-chain';

test('db:init fetches the embedder but not the reranker by default', () => {
  const plan = planChain('init', ['--target=dev']);
  assert.ok(plan);
  assert.deepEqual(plan.steps, [['--filter', '@snaglet/db', 'run', 'init'], ['embedder:fetch']]);
  assert.deepEqual(plan.args, ['--target=dev']);
  assert.equal(plan.dbStepCount, 1);
});

test('db:init --with-reranker also fetches the reranker and keeps the flag out of the db step', () => {
  const plan = planChain('init', ['--', '--target=dev', '--with-reranker']);
  assert.ok(plan);
  assert.deepEqual(plan.steps, [
    ['--filter', '@snaglet/db', 'run', 'init'],
    ['reranker:fetch'],
    ['embedder:fetch'],
  ]);
  assert.deepEqual(plan.args, ['--target=dev']);
});

test('db:migrate runs migrations then the tool sync, both with the target args', () => {
  const plan = planChain('migrate', ['--target=dev', '--dry-run']);
  assert.ok(plan);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.dbStepCount, 2);
  assert.deepEqual(plan.args, ['--target=dev', '--dry-run']);
});

test('an unknown command has no plan', () => {
  assert.equal(planChain('seed', []), null);
  assert.equal(planChain(undefined, []), null);
});
