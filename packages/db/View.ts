/**
 * View — Base class for CLI-friendly DB introspection and rendering.
 *
 * Complements Model by providing formatted output helpers for:
 * - describe()  → human-readable object overview
 * - schema()    → structured schema output
 * - sample()    → formatted sample rows
 * - stats()     → row count + nullable/index summary
 *
 * Intended usage:
 *   class AgentView extends View<typeof Agents> {
 *     constructor() {
 *       super({ model: Agents });
 *     }
 *   }
 */

import { clamp } from '@snaglet/shared/utils/math';
import type {
  ConstraintInfo,
  DbObjectKind as ModelDbObjectKind,
  IndexInfo,
  ViewDataSource,
} from './Model';
import { formatQueryRows } from './sql-utils';

type LogValue = string | number | boolean | null | undefined;

interface FormatSectionOptions {
  leadingBlankLine?: boolean;
  includeWhenEmpty?: boolean;
  emptyPlaceholder?: string;
}

function formatHeading(text: string): string {
  return text;
}

function formatSection(title: string, lines: string[], options?: FormatSectionOptions): string[] {
  const leadingBlankLine = options?.leadingBlankLine ?? true;
  const includeWhenEmpty = options?.includeWhenEmpty ?? false;
  const emptyPlaceholder = options?.emptyPlaceholder ?? '- (none)';

  if (lines.length === 0 && !includeWhenEmpty) return [];

  const prefix = leadingBlankLine ? [''] : [];
  if (lines.length === 0) return [...prefix, title, emptyPlaceholder];
  return [...prefix, title, ...lines];
}

function formatKeyValueLines(values: Record<string, LogValue>): string[] {
  return Object.entries(values).map(([key, value]) => `- ${key}: ${value ?? 'null'}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- upper bound for generic constraint; ViewDataSource<unknown> would over-restrict
export type ModelRowType<M extends ViewDataSource<any>> =
  M extends ViewDataSource<infer Row> ? Row : Record<string, unknown>;

export type DbObjectKind = ModelDbObjectKind;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- upper bound for generic constraint
export interface ViewDefinition<M extends ViewDataSource<any>> {
  model: M;
  /**
   * SQL schema namespace. Defaults to `public`.
   * This is metadata for introspection; Model.table is still the physical name.
   */
  schemaName?: string;
  /**
   * Optional display name. Defaults to model.table.
   */
  name?: string;
  /**
   * Optional one-line human description shown in describe().
   */
  description?: string;
}

export interface ViewColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
}

export type ViewConstraintInfo = ConstraintInfo;
export type ViewIndexInfo = IndexInfo;

export interface DescribeResult {
  schemaName: string;
  name: string;
  kind: DbObjectKind;
  description: string | null;
  columns: ViewColumnInfo[];
  constraints: ViewConstraintInfo[];
  indexes: ViewIndexInfo[];
}

export interface StatsResult {
  schemaName: string;
  name: string;
  kind: DbObjectKind;
  rowCount: number;
  nullableColumns: string[];
  indexCount: number;
  totalSize: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- upper bound for generic constraint
export class View<M extends ViewDataSource<any>> {
  readonly model: M;
  readonly schemaName: string;
  readonly name: string;
  readonly description: string | null;

  constructor(def: ViewDefinition<M>) {
    this.model = def.model;
    this.schemaName = def.schemaName ?? 'public';
    this.name = def.name ?? def.model.table;
    this.description = def.description ?? null;
  }

  async objectKind(): Promise<DbObjectKind> {
    return this.model.objectKind({ schemaName: this.schemaName });
  }

  async columns(): Promise<ViewColumnInfo[]> {
    const rows = await this.model.columns({ schemaName: this.schemaName });
    return rows.map((r) => ({
      name: r.name,
      type: r.type,
      nullable: r.nullable,
      defaultValue: r.defaultValue,
    }));
  }

  async constraints(): Promise<ViewConstraintInfo[]> {
    return this.model.constraints({ schemaName: this.schemaName });
  }

  async indexes(): Promise<ViewIndexInfo[]> {
    return this.model.indexes({ schemaName: this.schemaName });
  }

  async describeData(): Promise<DescribeResult> {
    const [kind, columns, constraints, indexes, descriptionRow] = await Promise.all([
      this.objectKind(),
      this.columns(),
      this.constraints(),
      this.indexes(),
      this.model.relationDescription({ schemaName: this.schemaName }),
    ]);

    return {
      schemaName: this.schemaName,
      name: this.name,
      kind,
      description: this.description ?? descriptionRow ?? null,
      columns,
      constraints,
      indexes,
    };
  }

  async describe(): Promise<string> {
    const info = await this.describeData();

    const lines: string[] = [
      formatHeading(`${info.kind.toUpperCase()}: ${info.schemaName}.${this.model.table}`),
    ];

    if (info.description) {
      lines.push(`Description: ${info.description}`);
    }

    const columnLines = info.columns.map((col) => {
      const nullableSummary = col.nullable ? 'nullable' : 'required';
      const defaultSummary = col.defaultValue ? `, default=${col.defaultValue}` : '';
      return `- ${col.name}: ${col.type} (${nullableSummary}${defaultSummary})`;
    });
    lines.push(
      ...formatSection(`Columns: ${info.columns.length}`, columnLines, { leadingBlankLine: false })
    );

    const constraintLines = info.constraints.map(
      (constraint) => `- ${constraint.name} (${constraint.type}): ${constraint.definition}`
    );
    lines.push(
      ...formatSection(`Constraints: ${info.constraints.length}`, constraintLines, {
        includeWhenEmpty: true,
      })
    );

    const indexLines = info.indexes.map((index) => `- ${index.name}: ${index.definition}`);
    lines.push(
      ...formatSection(`Indexes: ${info.indexes.length}`, indexLines, { includeWhenEmpty: true })
    );

    return lines.join('\n');
  }

  async schema(): Promise<string> {
    const [kind, columns, constraints, indexes] = await Promise.all([
      this.objectKind(),
      this.columns(),
      this.constraints(),
      this.indexes(),
    ]);

    const columnLines = columns.map((col) => {
      const nullableSummary = col.nullable ? 'NULL' : 'NOT NULL';
      const defaultSummary = col.defaultValue ? ` DEFAULT ${col.defaultValue}` : '';
      return `- ${col.name}: ${col.type} ${nullableSummary}${defaultSummary}`;
    });
    const constraintLines = constraints.map(
      (constraint) => `- ${constraint.name} (${constraint.type}): ${constraint.definition}`
    );
    const indexLines = indexes.map((index) => `- ${index.name}: ${index.definition}`);

    const lines = [
      formatHeading(`Schema: ${this.schemaName}.${this.model.table}`),
      ...formatKeyValueLines({
        Type: kind,
        Columns: columns.length,
        Constraints: constraints.length,
        Indexes: indexes.length,
      }),
      ...formatSection('Columns', columnLines, { includeWhenEmpty: true }),
      ...formatSection('Constraints', constraintLines, { includeWhenEmpty: true }),
      ...formatSection('Indexes', indexLines, { includeWhenEmpty: true }),
    ];

    return lines.join('\n');
  }

  async sample(limit: number = 5): Promise<string> {
    const normalizedLimit = clamp(Math.floor(limit), 1, 200);
    const rows = (await this.model.sample(normalizedLimit, {
      schemaName: this.schemaName,
    })) as Record<string, unknown>[];
    return formatQueryRows(rows, rows.length, normalizedLimit);
  }

  async statsData(): Promise<StatsResult> {
    const [kind, columns, indexes, rowCount, sizeRow] = await Promise.all([
      this.objectKind(),
      this.columns(),
      this.indexes(),
      this.model.count({ schemaName: this.schemaName }),
      this.model.relationSize({ schemaName: this.schemaName }),
    ]);

    return {
      schemaName: this.schemaName,
      name: this.name,
      kind,
      rowCount,
      nullableColumns: columns.filter((c) => c.nullable).map((c) => c.name),
      indexCount: indexes.length,
      totalSize: sizeRow ?? null,
    };
  }

  async stats(): Promise<string> {
    const stats = await this.statsData();
    const nullableSummary =
      stats.nullableColumns.length > 0 ? stats.nullableColumns.join(', ') : '(none)';

    const lines = [
      formatHeading(`Stats: ${stats.schemaName}.${this.model.table}`),
      ...formatKeyValueLines({
        Type: stats.kind,
        'Row count': stats.rowCount,
        'Total size': stats.totalSize ?? 'unknown',
        'Index count': stats.indexCount,
        'Nullable columns': nullableSummary,
      }),
    ];

    return lines.join('\n');
  }
}
