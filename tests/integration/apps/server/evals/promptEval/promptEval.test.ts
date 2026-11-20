/**
 * Prompt-eval runner qualification and the live entry point.
 *
 * Scripted (always runs): for each family the good script must pass its
 * oracle and the bad script must fail it, B and C must render different system
 * prompts that are each byte-stable across their own calls, and transcripts
 * must land on disk. If any of this fails, no live B/C number can be trusted.
 *
 * Live (opt-in): SNAGLET_PROMPT_EVAL_LIVE=1 runs paired B/C on a real model:
 *   SNAGLET_PROMPT_EVAL_VARIANT   path to a variant JSON ({id, edits:[{find,replace}]})
 *   SNAGLET_PROMPT_EVAL_FAMILIES  comma list (default: all)
 *   SNAGLET_PROMPT_EVAL_REPEATS   default 3
 *   SNAGLET_PROMPT_EVAL_MODEL     provider/model, default anthropic/claude-sonnet-4-6
 *   SNAGLET_PROMPT_EVAL_OUT       default .snaglet/prompt-evals/<runId>
 * Credential: an existing DB credential for the provider, else ANTHROPIC_API_KEY
 * is saved into this test's throwaway database (never printed or written out).
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import { mkdtemp, readFile, readdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import {
  pinConversationCompaction,
  pinEmbeddingsUnavailable,
} from '../../services/SocketService/waveScenarios/scenarioHarness';
import { FAMILIES } from './families';
import { runPaired, runTrial, type LiveModel } from './runner';
import type { PromptVariant } from '@server/services/SystemPromptComposer/promptVariant';

jest.setTimeout(600_000);

/** A harmless candidate that is guaranteed to apply: proves the seam works. */
const PROBE: PromptVariant = {
  id: 'C-probe',
  edits: [
    // The variant's one edit to block 3, matched case-exactly as it renders.
    { find: 'Identical repeat calls are blocked', replace: 'Identical repeat calls are refused' },
  ],
};

const LIVE = process.env.SNAGLET_PROMPT_EVAL_LIVE === '1';

describe('prompt-eval runner — scripted qualification', () => {
  pinConversationCompaction();
  pinEmbeddingsUnavailable();

  for (const family of Object.values(FAMILIES)) {
    it(`${family.id}: good script passes the oracle, every bad script fails it`, async () => {
      const good = await runTrial({
        runId: 'qual',
        family,
        arm: 'B',
        variant: PROBE,
        repeat: 0,
        mode: 'scripted',
        script: 'good',
      });
      expect(good.error).toBeUndefined();
      expect({
        success: good.oracle.success,
        safe: good.oracle.safe,
        notes: good.oracle.notes,
      }).toEqual(expect.objectContaining({ success: true, safe: true }));

      for (const kind of ['bad' as const, ...(family.extraBad ?? [])]) {
        const bad = await runTrial({
          runId: 'qual',
          family,
          arm: 'B',
          variant: PROBE,
          repeat: 1,
          mode: 'scripted',
          script: kind,
        });
        expect({ kind, error: bad.error }).toEqual({ kind, error: undefined });
        expect({ kind, safeSuccess: bad.safeSuccess }).toEqual({ kind, safeSuccess: false });
      }
    });
  }

  it('B and C differ by the variant, each arm is byte-stable, transcripts are written', async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), 'prompt-eval-'));
    const summary = await runPaired({
      runId: 'qualpair',
      families: ['durable-continuity'],
      variant: PROBE,
      repeats: 1,
      mode: 'scripted',
      outDir,
      order: () => ['B', 'C'],
    });
    const files = (await readdir(outDir)).sort();
    expect(files).toEqual(
      ['durable-continuity.r0.B.json', 'durable-continuity.r0.C.json', 'summary.json'].sort()
    );
    const b = JSON.parse(await readFile(path.join(outDir, 'durable-continuity.r0.B.json'), 'utf8'));
    const c = JSON.parse(await readFile(path.join(outDir, 'durable-continuity.r0.C.json'), 'utf8'));
    expect(b.systemHashes.length).toBeGreaterThan(1);
    expect(new Set(b.systemHashes).size).toBe(1);
    expect(new Set(c.systemHashes).size).toBe(1);
    expect(b.systemHashes[0]).not.toBe(c.systemHashes[0]);
    expect(b.transcript.length).toBeGreaterThan(0);
    expect(b.toolCalls.some((t: { tool: string }) => t.tool === 'doc')).toBe(true);
    expect(summary.rows[0]).toEqual(
      expect.objectContaining({ family: 'durable-continuity', B: 1, C: 1, worsePairs: 0 })
    );
    expect(summary.ship).toBe(true);
    // No secret material in transcripts.
    expect(JSON.stringify([b, c])).not.toMatch(/sk-ant-|ANTHROPIC_API_KEY/);
  });
});

(LIVE ? describe : describe.skip)('prompt-eval — live paired B/C (opt-in)', () => {
  pinEmbeddingsUnavailable();
  let created: string | null = null;

  afterAll(async () => {
    if (created) await providerCredentialService.remove(created);
  });

  it('runs paired trials and writes a summary', async () => {
    const [providerId, ...rest] = (
      process.env.SNAGLET_PROMPT_EVAL_MODEL ?? 'anthropic/claude-sonnet-4-6'
    ).split('/');
    const modelId = rest.join('/');
    let credentialId: string | null = null;
    const existing = await providerCredentialService.getSecret(providerId!);
    if (!existing) {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error('Live eval needs a stored credential or ANTHROPIC_API_KEY.');
      const saved = await providerCredentialService.save({
        providerId: providerId!,
        authTypeId: `${providerId}:api-key`,
        authType: 'api_key',
        label: 'prompt-eval (throwaway test DB)',
        secret: key,
      });
      created = saved.id;
      credentialId = saved.id;
    }
    const live: LiveModel = { providerId: providerId!, modelId, credentialId };

    const variantPath = process.env.SNAGLET_PROMPT_EVAL_VARIANT;
    const variant: PromptVariant = variantPath
      ? JSON.parse(await readFile(variantPath, 'utf8'))
      : PROBE;
    const families = (process.env.SNAGLET_PROMPT_EVAL_FAMILIES ?? Object.keys(FAMILIES).join(','))
      .split(',')
      .map((f) => f.trim()) as Array<keyof typeof FAMILIES>;
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${variant.id}`;
    const outDir =
      process.env.SNAGLET_PROMPT_EVAL_OUT ??
      path.join(process.cwd(), '.snaglet', 'prompt-evals', runId);

    const summary = await runPaired({
      runId,
      families,
      variant,
      repeats: Number(process.env.SNAGLET_PROMPT_EVAL_REPEATS ?? 3),
      mode: 'live',
      live,
      outDir,
    });
    // Reported, not asserted: a live result is evidence, not a unit expectation.
    console.log(JSON.stringify(summary, null, 2));
    expect(summary.rows.length).toBe(families.length);
  });
});
