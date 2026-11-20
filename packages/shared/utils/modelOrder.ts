/**
 * The order and labels of a provider's models wherever they are listed for a
 * person to pick from: newest and most capable first, read from the model ids
 * so no sort numbers have to be kept by hand.
 *
 * An id is read as a model line, a version and optional markers. In
 * `claude-opus-4-5-20251101` the line is `claude`, the version 4.5, the tier
 * opus and the snapshot date 20251101; `claude-opus-4-7[1m]` is the 1M-context
 * variant of `claude-opus-4-7`; `gpt-5.2-pro` is line `gpt`, version 5.2;
 * `qwen2.5:3b` is line `qwen`, version 2.5. Size tokens (`7b`, `16k`) are not
 * versions, and a dotted minor is a decimal (`grok-4.20` comes before
 * `grok-4.7`).
 *
 * Within one provider:
 * 1. Current models come before ones marked legacy or deprecated
 *    (`metadata.lifecycle`); each group is ordered the same way.
 * 2. Ids with a version come first. Lines keep the order of their first model
 *    in the list; within a line, the newest major version comes first, then
 *    the tier (mythos, fable, opus, sonnet, haiku; an id naming none comes
 *    after), then the newest minor version, then the list order. For Claude
 *    that lists Fable 5.2, Fable 5.1, Fable 5, Opus 5.5, Opus 5, Sonnet 5.5 …
 * 3. A context variant (`[1m]`, `-1m`) or a dated snapshot of an id that is
 *    also listed follows that id: the variant, then the snapshots.
 * 4. Ids with no readable version keep their list order, after the ones with
 *    one.
 *
 * The list order is the caller's: the catalog reads rows by `sort_order` then
 * `model_id`, so `sort_order` only breaks ties. Sorting a sorted list again
 * gives the same list.
 */

/** The fields the order reads. */
interface OrderableModel {
  providerId?: string | null;
  modelId: string;
  metadata?: { lifecycle?: string } | null;
}

/** The fields a picker label reads. */
interface LabeledModel extends OrderableModel {
  displayName?: string | null;
}

/** Tiers in the order a picker lists them, most capable first. */
const TIERS = ['mythos', 'fable', 'opus', 'sonnet', 'haiku'];
/** A context-window variant suffix: `claude-opus-4-7[1m]`, `model-1m`. */
const CONTEXT_VARIANT = /(?:\[[^\]]*\]|-1m)$/i;
/** A snapshot date at the end of an id: `-20251101`, `-2025-11-01`, `-0613`, `@20250514`. */
const DATE_STAMP = /[-_@](\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/;
/** A token that starts a version: `4`, `5.2`, `4o`, `o3`, `qwen2.5`, `k2.7`. */
const VERSION_START = /^([a-z]*?)(\d{1,2}(?:\.\d{1,2})*)([a-z]?)$/;
/** A token that continues a version written with dashes: the `5` of `claude-opus-4-5`. */
const VERSION_PART = /^\d{1,2}$/;
/** Suffixes that make a number a size, not a version: `7b`, `16k`, `270m`, `16e`, `1t`. */
const SIZE_SUFFIXES = new Set(['b', 'e', 'k', 'm', 't']);

interface Reading {
  line: string;
  version: number[];
  tier: number;
}

interface IdParts {
  /** The id without its context variant and snapshot date. */
  stem: string;
  /** The id without its context variant, when it had one. */
  unvaried: string;
  stamp: string | null;
  variant: boolean;
  reading: Reading | null;
}

/** Line, version and tier of an id with no variant or date, or null when it names no version. */
function readStem(stem: string): Reading | null {
  const tokens = stem
    .toLowerCase()
    .split(/[-_/:\s]+/)
    .filter(Boolean);
  const tier = tokens.findIndex((token) => TIERS.includes(token));
  const words = tokens.filter((token) => !TIERS.includes(token));
  for (let i = 0; i < words.length; i += 1) {
    const match = VERSION_START.exec(words[i] ?? '');
    if (!match || SIZE_SUFFIXES.has(match[3] ?? '')) continue;
    // A dotted part is a decimal fraction (`4.20` is 4.2, before `4.7`); a
    // dashed part is a whole number (`claude-opus-4-5` is 4.5).
    const [major = '0', ...minors] = (match[2] ?? '').split('.');
    const version = [Number(major), ...minors.map((part) => Number(`0.${part}`))];
    for (let j = i + 1; j < words.length && VERSION_PART.test(words[j] ?? ''); j += 1) {
      version.push(Number(words[j]));
    }
    const line = [...words.slice(0, i), match[1]].filter(Boolean).join('-');
    return {
      line,
      version,
      tier: tier >= 0 ? TIERS.indexOf(tokens[tier] ?? '') : TIERS.length,
    };
  }
  return null;
}

function readId(modelId: string): IdParts {
  const unvaried = modelId.replace(CONTEXT_VARIANT, '');
  const dated = DATE_STAMP.exec(unvaried);
  const stem = dated ? unvaried.slice(0, dated.index) : unvaried;
  return {
    stem,
    unvaried,
    stamp: dated ? (dated[1] ?? null) : null,
    variant: unvaried !== modelId,
    reading: readStem(stem),
  };
}

/** Newest first, comparing from `from` on: 5.5 before 5.2 before 5; a missing part counts as 0. */
function compareVersionsDescending(left: number[], right: number[], from = 0): number {
  for (let i = from; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Group a list by provider, providers in the order they first appear. */
function byProvider<T extends OrderableModel>(models: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const key = model.providerId ?? '';
    const group = groups.get(key);
    if (group) group.push(model);
    else groups.set(key, [model]);
  }
  return [...groups.values()];
}

function sortOneProvider<T extends OrderableModel>(models: readonly T[]): T[] {
  const indexById = new Map(models.map((model, index) => [model.modelId, index] as const));
  const parts = models.map((model) => readId(model.modelId));
  // A variant or snapshot follows the listed id it was made from.
  const anchors = parts.map((part, index) => {
    for (const candidate of [part.stem, part.unvaried]) {
      const found = indexById.get(candidate);
      if (found !== undefined && found !== index) return found;
    }
    return index;
  });
  const lineRank = new Map<string, number>();
  parts.forEach((part, index) => {
    if (part.reading && !lineRank.has(part.reading.line)) lineRank.set(part.reading.line, index);
  });
  // The anchor itself, then its context variant, then its snapshots.
  const placeInGroup = (index: number): number => {
    if (anchors[index] === index) return 0;
    return parts[index]?.stamp ? 2 : 1;
  };

  const notCurrent = models.map((model) => (model.metadata?.lifecycle ? 1 : 0));

  const order = models.map((_, index) => index);
  order.sort((left, right) => {
    const byLifecycle = (notCurrent[left] ?? 0) - (notCurrent[right] ?? 0);
    if (byLifecycle !== 0) return byLifecycle;
    const leftAnchor = anchors[left] ?? left;
    const rightAnchor = anchors[right] ?? right;
    const leftReading = parts[leftAnchor]?.reading ?? null;
    const rightReading = parts[rightAnchor]?.reading ?? null;
    if (leftReading && !rightReading) return -1;
    if (!leftReading && rightReading) return 1;
    if (leftReading && rightReading) {
      const byLine = (lineRank.get(leftReading.line) ?? 0) - (lineRank.get(rightReading.line) ?? 0);
      if (byLine !== 0) return byLine;
      const byMajor = (rightReading.version[0] ?? 0) - (leftReading.version[0] ?? 0);
      if (byMajor !== 0) return byMajor;
      if (leftReading.tier !== rightReading.tier) return leftReading.tier - rightReading.tier;
      const byMinor = compareVersionsDescending(leftReading.version, rightReading.version, 1);
      if (byMinor !== 0) return byMinor;
    }
    if (leftAnchor !== rightAnchor) return leftAnchor - rightAnchor;
    const byPlace = placeInGroup(left) - placeInGroup(right);
    if (byPlace !== 0) return byPlace;
    const byVariant = Number(parts[left]?.variant) - Number(parts[right]?.variant);
    return byVariant !== 0 ? byVariant : left - right;
  });
  return order.map((index) => models[index] as T);
}

/**
 * Models in picker order (see the file comment), each provider's models
 * together, providers in the order they first appear. Never throws on an id
 * it cannot read: such ids keep their place after the readable ones.
 */
export function sortModels<T extends OrderableModel>(models: readonly T[]): T[] {
  return byProvider(models).flatMap((group) => sortOneProvider(group));
}

/**
 * One picker label per model, in the list's order, never the same twice
 * within a provider (ignoring case). When models of one provider share a
 * display name, one keeps it plain: the model whose id is that name, else the
 * first in the list (pass the list in picker order, so an alias comes before
 * its snapshots). Each other one adds its snapshot date (`Claude Opus 4.5
 * (20251101)`), or its id when it has no date or the name already shows it.
 */
export function modelOptionLabels<T extends LabeledModel>(models: readonly T[]): string[] {
  const nameOf = (model: T) => model.displayName?.trim() || model.modelId;
  const labels = new Map<T, string>();
  for (const group of byProvider(models)) {
    const sharing = new Map<string, T[]>();
    for (const model of group) {
      const key = nameOf(model).toLowerCase();
      const same = sharing.get(key);
      if (same) same.push(model);
      else sharing.set(key, [model]);
    }
    const taken = new Set(sharing.keys());
    for (const [key, same] of sharing) {
      const keeper = same.find((model) => model.modelId.toLowerCase() === key) ?? same[0];
      for (const model of same) {
        const name = nameOf(model);
        if (model === keeper) {
          labels.set(model, name);
          continue;
        }
        const stamp = readId(model.modelId).stamp;
        let label =
          stamp && !name.includes(stamp) ? `${name} (${stamp})` : `${name} (${model.modelId})`;
        if (taken.has(label.toLowerCase())) label = `${name} (${model.modelId})`;
        taken.add(label.toLowerCase());
        labels.set(model, label);
      }
    }
  }
  return models.map((model) => labels.get(model) ?? model.modelId);
}
