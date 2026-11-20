import * as chrono from 'chrono-node';

type SearchTimeRangeMode = 'filter' | 'boost';
type SearchTimeRangeField = 'created_at' | 'updated_at' | 'activity_at';

type SearchTimeRangeInput = {
  from?: unknown;
  to?: unknown;
  mode?: unknown;
  field?: unknown;
};

export type NormalizedSearchTimeRange = {
  from: string | null;
  to: string | null;
  mode: SearchTimeRangeMode;
  field: SearchTimeRangeField;
  label?: string;
  source: 'explicit' | 'query';
};

export type ResolvedSearchTimeRange = {
  query: string;
  timeRange: NormalizedSearchTimeRange | null;
};

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function addMonths(date: Date, months: number): Date {
  const out = new Date(date);
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function toIso(date: Date): string {
  return date.toISOString();
}

function parseDateBoundary(value: unknown, label: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error(`time_range.${label} must be an ISO date string`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`time_range.${label} must be a valid ISO date string`);
  }
  return parsed.toISOString();
}

function parseMode(value: unknown): SearchTimeRangeMode {
  if (value == null || value === '') return 'filter';
  if (value === 'filter' || value === 'boost') return value;
  throw new Error('time_range.mode must be one of: filter, boost');
}

function parseField(value: unknown): SearchTimeRangeField {
  if (value == null || value === '') return 'activity_at';
  if (value === 'created_at' || value === 'updated_at' || value === 'activity_at') return value;
  throw new Error('time_range.field must be one of: created_at, updated_at, activity_at');
}

// Detect leading field qualifier: "created yesterday", "updated last week".
// Returns { field, remainder } if matched; otherwise null.
function detectFieldPrefix(
  query: string
): { field: SearchTimeRangeField; remainder: string; matched: string } | null {
  const match = query.match(/\b(created|updated|modified)\b/i);
  if (!match || match.index === undefined) return null;
  const verb = match[0].toLowerCase();
  const field: SearchTimeRangeField = verb === 'created' ? 'created_at' : 'updated_at';
  const remainder = (query.slice(0, match.index) + query.slice(match.index + match[0].length))
    .replace(/\s+/g, ' ')
    .trim();
  return { field, remainder, matched: match[0] };
}

// Inspect the natural-language matched text for an explicit period unit. Chrono
// returns the *start day* of a period ("last week" → Monday) but doesn't widen
// the range to span the period — we have to.
function periodFromText(text: string): 'week' | 'month' | 'year' | null {
  const lower = text.toLowerCase();
  if (/\b(weeks?)\b/.test(lower)) return 'week';
  if (/\b(months?)\b/.test(lower)) return 'month';
  if (/\b(years?|annually|annual)\b/.test(lower)) return 'year';
  return null;
}

// Snap a chrono ParsedComponents to a [from, to) window. Uses the matched text
// to detect period units (week/month/year) since chrono returns only a start
// instant for relative periods. Returns null when no usable range can be derived.
function chronoComponentToRange(
  start: chrono.ParsedComponents,
  end: chrono.ParsedComponents | null,
  matchedText: string
): { from: Date; to: Date } | null {
  const startDate = start.date();
  if (!startDate || Number.isNaN(startDate.getTime())) return null;

  const hasHour = start.isCertain('hour') || start.isCertain('minute');

  // Explicit two-component range ("between X and Y", "from Mon to Fri").
  if (end) {
    const endDate = end.date();
    if (endDate && !Number.isNaN(endDate.getTime()) && endDate > startDate) {
      const endHasHour = end.isCertain('hour') || end.isCertain('minute');
      if (hasHour || endHasHour) return { from: startDate, to: endDate };
      const endMonthOnly = end.isCertain('month') && !end.isCertain('day');
      const startMonthOnly = start.isCertain('month') && !start.isCertain('day');
      const widenedEnd = endMonthOnly
        ? startOfMonth(addMonths(endDate, 1))
        : startOfDay(addDays(endDate, 1));
      const widenedStart = startMonthOnly ? startOfMonth(startDate) : startOfDay(startDate);
      return { from: widenedStart, to: widenedEnd };
    }
  }

  // Hour-granular single instant — 1-hour window (e.g. "at 3pm today").
  if (hasHour) {
    const to = new Date(startDate.getTime() + 60 * 60 * 1000);
    return { from: startDate, to };
  }

  // Period keyword in the matched text trumps the day-granular start.
  // "last week" → chrono gives Mon, we widen to Mon..next-Mon.
  // "two weeks ago" → chrono gives that day, we widen to a 7-day window from there.
  const period = periodFromText(matchedText);
  if (period === 'week') {
    const from = startOfDay(startDate);
    return { from, to: addDays(from, 7) };
  }
  if (period === 'month') {
    const from = startOfMonth(startDate);
    return { from, to: addMonths(from, 1) };
  }
  if (period === 'year') {
    const from = new Date(Date.UTC(startDate.getUTCFullYear(), 0, 1));
    const to = new Date(Date.UTC(startDate.getUTCFullYear() + 1, 0, 1));
    return { from, to };
  }

  // No period keyword — fall back to chrono's certainty levels.
  if (start.isCertain('day')) {
    const from = startOfDay(startDate);
    return { from, to: addDays(from, 1) };
  }
  if (start.isCertain('month')) {
    const from = startOfMonth(startDate);
    return { from, to: addMonths(from, 1) };
  }
  if (start.isCertain('year')) {
    const from = new Date(Date.UTC(startDate.getUTCFullYear(), 0, 1));
    const to = new Date(Date.UTC(startDate.getUTCFullYear() + 1, 0, 1));
    return { from, to };
  }

  const from = startOfDay(startDate);
  return { from, to: addDays(from, 1) };
}

function rangeFromQuery(query: string, now: Date): ResolvedSearchTimeRange {
  // 1. Detect optional field prefix ("created" / "updated" / "modified").
  const fieldPrefix = detectFieldPrefix(query);
  const fieldFromPrefix: SearchTimeRangeField | null = fieldPrefix?.field ?? null;
  const parseTarget = fieldPrefix ? fieldPrefix.remainder : query;

  // 2. Try chrono first — it handles "yesterday", "last week", "this month",
  // "February", "5 days ago", "between Jan and Mar", etc.
  if (parseTarget.trim().length > 0) {
    const parsed = chrono.parse(parseTarget, now, { forwardDate: false });
    if (parsed.length > 0) {
      const first = parsed[0];
      const last = parsed[parsed.length - 1];

      // Multi-component "between X and Y" / "from X to Y": merge first.start
      // with last.start as a synthetic end if the connector text is bridging.
      const bridgingPhrase =
        parsed.length > 1 &&
        /\b(between|from)\b/i.test(parseTarget) &&
        /\b(and|to|through|\-)\b/i.test(parseTarget);
      const endComponent = first.end ?? (bridgingPhrase && last !== first ? last.start : null);

      // Build matched-text span covering all components when bridging,
      // otherwise just the first component's text.
      const matchedText = bridgingPhrase
        ? parseTarget.slice(first.index, last.index + last.text.length)
        : first.text;

      const range = chronoComponentToRange(first.start, endComponent, matchedText);
      if (range && range.to > range.from) {
        // Strip the matched text from the user-visible query so the search
        // terms minus the date phrase get embedded.
        let cleaned = parseTarget
          .replace(matchedText, ' ')
          .replace(/\s+/g, ' ')
          .replace(/\s+([?.!,])/g, '$1')
          .trim();
        // Strip trailing connector words left behind ("in", "on", "from",
        // "during") that read awkwardly when their date phrase is removed.
        cleaned = cleaned.replace(/\b(in|on|from|during|at|by|between)\s*$/i, '').trim();
        return {
          query: cleaned.length > 0 ? cleaned : query,
          timeRange: {
            from: toIso(range.from),
            to: toIso(range.to),
            mode: 'filter',
            field: fieldFromPrefix ?? 'activity_at',
            label: fieldPrefix ? `${fieldPrefix.matched} ${matchedText}`.trim() : matchedText,
            source: 'query',
          },
        };
      }
    }
  }

  // 3. Recency boost — chrono doesn't model vague "recent/recently/lately" as
  // a date range. Keep these as a soft boost over the last 30 days.
  if (/\b(recent|recently|lately)\b/i.test(query)) {
    const from = addDays(startOfDay(now), -30);
    const cleaned = query
      .replace(/\b(recent|recently|lately)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      query: cleaned.length > 0 ? cleaned : query,
      timeRange: {
        from: toIso(from),
        to: null,
        mode: 'boost',
        field: fieldFromPrefix ?? 'activity_at',
        label: 'recently',
        source: 'query',
      },
    };
  }

  // 4. Field-prefix matched but no date — not a usable filter; return original
  // query without modification so the caller can search normally.
  return { query, timeRange: null };
}

export function resolveSearchTimeRange(args: {
  query: string;
  timeRange?: unknown;
  now?: Date;
}): ResolvedSearchTimeRange {
  const explicit = args.timeRange;
  if (explicit != null) {
    if (typeof explicit !== 'object' || Array.isArray(explicit)) {
      throw new Error('time_range must be an object');
    }
    const input = explicit as SearchTimeRangeInput;
    const from = parseDateBoundary(input.from, 'from');
    const to = parseDateBoundary(input.to, 'to');
    if (!from && !to) {
      throw new Error('time_range requires at least one of from or to');
    }
    if (from && to && Date.parse(from) >= Date.parse(to)) {
      throw new Error('time_range.from must be before time_range.to');
    }
    return {
      query: args.query,
      timeRange: {
        from,
        to,
        mode: parseMode(input.mode),
        field: parseField(input.field),
        source: 'explicit',
      },
    };
  }

  return rangeFromQuery(args.query, args.now ?? new Date());
}

export function timeRangeParams(
  range: NormalizedSearchTimeRange | null
): [string | null, string | null] {
  return [range?.from ?? null, range?.to ?? null];
}

export function timeRangeFilterSql(
  expression: string,
  range: NormalizedSearchTimeRange | null,
  fromIndex: number,
  toIndex: number
): string {
  if (!range || range.mode !== 'filter') {
    // Keep both placeholders present-but-inert so the bound param count stays in
    // lockstep with timeRangeParams() (which always binds 2). The bare reference
    // must carry a ::timestamptz cast so Postgres can resolve the parameter type
    // even when the bound value is NULL — otherwise queries that omit time_range
    // fail with "could not determine data type of parameter $N".
    return `
    AND ($${fromIndex}::timestamptz IS NULL OR TRUE)
    AND ($${toIndex}::timestamptz IS NULL OR TRUE)
  `;
  }
  return `
    AND ($${fromIndex}::timestamptz IS NULL OR ${expression} >= $${fromIndex}::timestamptz)
    AND ($${toIndex}::timestamptz IS NULL OR ${expression} < $${toIndex}::timestamptz)
  `;
}

export function timeRangeBoostSql(
  expression: string,
  range: NormalizedSearchTimeRange | null,
  fromIndex: number,
  toIndex: number
): string {
  if (!range || range.mode !== 'boost') {
    // Inert boost that still references both placeholders (with ::timestamptz
    // casts) so the bound param count stays in lockstep with timeRangeParams()
    // and Postgres can resolve the parameter types even when the values are
    // NULL. The expression always evaluates to 1.0, so ranking is unaffected.
    // Without referencing $fromIndex/$toIndex here, a query that omits
    // time_range binds two unused params and fails with
    // "could not determine data type of parameter $N".
    return `(CASE WHEN $${fromIndex}::timestamptz IS NULL OR $${toIndex}::timestamptz IS NULL OR TRUE THEN 1.0 ELSE 1.0 END)`;
  }
  return `
    CASE
      WHEN ($${fromIndex}::timestamptz IS NULL OR ${expression} >= $${fromIndex}::timestamptz)
       AND ($${toIndex}::timestamptz IS NULL OR ${expression} < $${toIndex}::timestamptz)
      THEN 1.2
      ELSE 1
    END
  `;
}
