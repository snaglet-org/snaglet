/**
 * `run` chips — the kind contract and its id shortening.
 *
 * A run is execution history, NOT a workspace node: `public.node_type` has no
 * `run` member, so a run chip must round-trip as a drag payload while never
 * pretending to be a resolvable node. These tests pin the two properties that
 * would break silently: the kind being accepted by the drag payload readers,
 * and the totality of the per-kind maps (a missing entry is a typecheck error
 * today, but `fallbackTitleForKind` returning undefined at runtime is not).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  hasChipDragData,
  isChipKind,
  parseRunPlainText,
  readChipDragData,
  setActiveDragChip,
  writeChipDragData,
  NODE_CHIP_MIME,
  NODE_CHIP_TEXT_PREFIX,
  type NodeChipData,
} from './payload';
import { fallbackTitleForKind, isIncludableKind, KIND_TO_SCHEME } from './kinds';
import { shortRunId } from './runChip';

// Run ids are bare randomUUID() values (turnLoop.ts) — no `run-` prefix.
const RUN_ID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

const runChip: NodeChipData = {
  id: RUN_ID,
  kind: 'run',
  title: 'mango',
};

function fakeDataTransfer(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() {
      return [...store.keys()];
    },
  } as unknown as DataTransfer;
}

describe('run chip kind', () => {
  beforeEach(() => setActiveDragChip(null));

  it('is a recognized chip kind', () => {
    expect(isChipKind('run')).toBe(true);
  });

  it('round-trips through the canonical MIME without the in-memory store', () => {
    const dt = fakeDataTransfer();
    writeChipDragData(dt, runChip);
    // Clear the WKWebView fallback so we exercise the real MIME parse — that
    // is the path a cross-surface drop actually takes.
    setActiveDragChip(null);
    expect(dt.getData(NODE_CHIP_MIME)).toContain('"kind":"run"');
    expect(readChipDragData(dt)).toEqual(runChip);
  });

  it('has entries in both per-kind maps (they must stay total over ChipKind)', () => {
    expect(KIND_TO_SCHEME.run).toBe('run');
    expect(fallbackTitleForKind('run')).toBe('Run');
  });

  it('is never transcluded — a run has no content to splice', () => {
    expect(isIncludableKind('run')).toBe(false);
  });
});

describe('run chip text/plain contract', () => {
  beforeEach(() => setActiveDragChip(null));

  it('emits the bare `run:<id>` scheme for external apps, not the JSON envelope', () => {
    const dt = fakeDataTransfer();
    writeChipDragData(dt, runChip);

    // The exact value a user gets when dropping into a terminal or editor.
    expect(dt.getData('text/plain')).toBe(`run:${RUN_ID}`);
    expect(dt.getData('text/plain')).not.toContain(NODE_CHIP_TEXT_PREFIX);
  });

  it('leaves every other kind on the JSON envelope', () => {
    const dt = fakeDataTransfer();
    writeChipDragData(dt, { id: 'doc-1111111111111-nm6mjg7xf', kind: 'doc', title: 'Notes' });
    expect(dt.getData('text/plain')).toBe(
      `${NODE_CHIP_TEXT_PREFIX}${JSON.stringify({
        id: 'doc-1111111111111-nm6mjg7xf',
        kind: 'doc',
        title: 'Notes',
      })}`
    );
  });

  it('keeps the internal custom-MIME path intact alongside the new plain text', () => {
    const dt = fakeDataTransfer();
    writeChipDragData(dt, runChip);
    setActiveDragChip(null);
    // Canonical MIME still carries the full chip, so same-page drops keep
    // the agent-name title even though text/plain does not hold it.
    expect(readChipDragData(dt)).toEqual(runChip);
  });

  it('parses the plain-text flavor back when it is the only one that survived', () => {
    const dt = fakeDataTransfer({ 'text/plain': `run:${RUN_ID}` });
    expect(hasChipDragData(dt)).toBe(true);
    expect(readChipDragData(dt)).toEqual({ id: RUN_ID, kind: 'run', title: null, name: null });
  });

  it('does not mistake ordinary prose beginning "run:" for a chip', () => {
    expect(parseRunPlainText('run: go fix the thing')).toBeNull();
    expect(parseRunPlainText('run:not-a-uuid')).toBeNull();
    expect(parseRunPlainText('')).toBeNull();
    const dt = fakeDataTransfer({ 'text/plain': 'run: go fix the thing' });
    expect(readChipDragData(dt)).toBeNull();
  });
});

describe('shortRunId', () => {
  it('shows the leading UUID group, short-SHA style', () => {
    expect(shortRunId(RUN_ID)).toBe('3f2a1b4c');
  });

  it('distinguishes runs that differ only in the first group', () => {
    expect(shortRunId('aaaaaaaa-5d6e-4f70-8a9b-0c1d2e3f4a5b')).not.toBe(
      shortRunId('bbbbbbbb-5d6e-4f70-8a9b-0c1d2e3f4a5b')
    );
  });

  it('returns short or unshaped ids unchanged rather than slicing them into nonsense', () => {
    expect(shortRunId('abc')).toBe('abc');
    expect(shortRunId('')).toBe('');
  });
});
