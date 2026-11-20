/**
 * Database statistics route
 *
 * GET /api/db/stats — database size and per-table sizes, shown in
 *                     Settings → Data → Backups.
 *
 * Covers `public` and `user_tables`, the schema of the physical tables behind
 * custom tables (named `user_tables.<name>`). Custom tables themselves are read
 * and written through /api/tables.
 */

import { Router } from 'express';
import { CUSTOM_TABLES_SCHEMA, getDb } from '@snaglet/db';
import { asyncHandler } from '@server/middleware';
import type { DbStatsResponse, DbTableSize } from '@snaglet/shared/types';

const router = Router();

const SIZED_SCHEMAS = ['public', CUSTOM_TABLES_SCHEMA] as const;

router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const pool = getDb();

    const { rows: sizeRows } = await pool.query<{ size: string }>(`
      SELECT pg_size_pretty(pg_database_size(current_database())) AS size
    `);

    const { rows: tableSizeRows } = await pool.query<DbTableSize>(
      `SELECT
         CASE WHEN schemaname = 'public' THEN tablename ELSE schemaname || '.' || tablename END AS table_name,
         pg_size_pretty(pg_total_relation_size(format('%I.%I', schemaname, tablename))) AS total_size,
         pg_size_pretty(pg_relation_size(format('%I.%I', schemaname, tablename))) AS table_size,
         pg_size_pretty(pg_total_relation_size(format('%I.%I', schemaname, tablename)) - pg_relation_size(format('%I.%I', schemaname, tablename))) AS indexes_size
       FROM pg_tables
       WHERE schemaname = ANY($1::text[])
       ORDER BY pg_total_relation_size(format('%I.%I', schemaname, tablename)) DESC`,
      [SIZED_SCHEMAS]
    );

    const body: DbStatsResponse = {
      database_size: sizeRows[0]?.size ?? '0 bytes',
      tables: tableSizeRows,
    };
    res.json(body);
  })
);

export default router;
