/**
 * ledger — the e2e harness's single source of truth for pass/fail.
 *
 * One `[PASS] / [FAIL] / [SKIPPED reason] <operation>` line per operation, in
 * order, grouped by phase. `pnpm test:e2e` exits nonzero when any op FAILs
 * (a SKIP is not a failure — but every SKIP must carry a justification, which
 * the recorder enforces). This is deliberately not jest: the whole point is a
 * flat, greppable, human-auditable transcript of "every operation, starting
 * from an empty workspace."
 */

import { getErrorMessage } from '@snaglet/shared/utils';

export type Status = 'PASS' | 'FAIL' | 'SKIPPED';

export interface LedgerEntry {
  phase: string;
  op: string;
  status: Status;
  /** Required for SKIPPED (why), optional detail for PASS/FAIL. */
  note?: string;
  ms?: number;
}

export class Ledger {
  private readonly entries: LedgerEntry[] = [];
  private currentPhase = '';

  phase(name: string): void {
    this.currentPhase = name;
  }

  private push(e: LedgerEntry): void {
    this.entries.push(e);
    // Stream each line as it happens so a hang is diagnosable from the tail.
    const tail =
      e.status === 'SKIPPED'
        ? `[SKIPPED ${e.note ?? 'no reason given'}]`
        : `[${e.status}]${e.ms != null ? ` (${e.ms}ms)` : ''}`;
    const detail = e.status !== 'SKIPPED' && e.note ? `  — ${e.note}` : '';
    process.stdout.write(`${tail} ${e.op}${detail}\n`);
  }

  pass(op: string, note?: string, ms?: number): void {
    this.push({ phase: this.currentPhase, op, status: 'PASS', note, ms });
  }

  fail(op: string, note?: string, ms?: number): void {
    this.push({ phase: this.currentPhase, op, status: 'FAIL', note, ms });
  }

  skip(op: string, reason: string): void {
    this.push({ phase: this.currentPhase, op, status: 'SKIPPED', note: reason });
  }

  /**
   * Run an async op, timing it, recording PASS on a truthy/void return and FAIL
   * on throw or an explicit `false`. The op may return a string note to attach.
   */
  async op(name: string, fn: () => Promise<void | boolean | string>): Promise<boolean> {
    const t0 = Date.now();
    try {
      const r = await fn();
      const ms = Date.now() - t0;
      if (r === false) {
        this.fail(name, 'returned false', ms);
        return false;
      }
      this.pass(name, typeof r === 'string' ? r : undefined, ms);
      return true;
    } catch (err) {
      const ms = Date.now() - t0;
      this.fail(name, getErrorMessage(err), ms);
      return false;
    }
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  counts(): { pass: number; fail: number; skip: number } {
    return {
      pass: this.entries.filter((e) => e.status === 'PASS').length,
      fail: this.entries.filter((e) => e.status === 'FAIL').length,
      skip: this.entries.filter((e) => e.status === 'SKIPPED').length,
    };
  }

  hasFailure(): boolean {
    return this.entries.some((e) => e.status === 'FAIL');
  }

  /** A compact per-phase summary line for the final banner. */
  summary(): string {
    const byPhase = new Map<string, { pass: number; fail: number; skip: number }>();
    for (const e of this.entries) {
      const c = byPhase.get(e.phase) ?? { pass: 0, fail: 0, skip: 0 };
      if (e.status === 'PASS') c.pass++;
      else if (e.status === 'FAIL') c.fail++;
      else c.skip++;
      byPhase.set(e.phase, c);
    }
    const lines: string[] = [];
    for (const [phase, c] of byPhase) {
      lines.push(`  ${phase}: ${c.pass} pass, ${c.fail} fail, ${c.skip} skip`);
    }
    return lines.join('\n');
  }
}
