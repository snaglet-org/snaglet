/**
 * /api/settings — typed setting overrides + registry discovery.
 *
 * Three GETs and two writes:
 *   GET    /api/settings                       → list overrides (only rows)
 *   GET    /api/settings/registry              → every registered setting with current value
 *   GET    /api/settings/:category/:key        → one setting's current value
 *   PUT    /api/settings/:category/:key        → replace the value
 *   PATCH  /api/settings/:category/:key        → shallow-merge into an object value (row-locked)
 *   DELETE /api/settings/:category/:key        → revert (remove the row)
 *   PUT    /api/settings/:category/:key/entries/:entry[/:subEntry] → set one map entry
 *   DELETE /api/settings/:category/:key/entries/:entry[/:subEntry] → remove one map entry
 *
 * The entry routes exist for map-valued settings (per-agent / per-thread
 * overrides): each window changes only its own entry, so two windows saving
 * different entries never overwrite each other.
 *
 * Validation runs through the typed registry (apps/server/src/services/settings).
 * PUT/PATCH bodies are real JSONB — no more `JSON.stringify({ value: JSON.stringify(...) })`
 * Callers receive typed JSON values directly instead of nested JSON strings.
 */

import { Router, type Request, type Response } from 'express';
import { Settings } from '@snaglet/db/tables/settings';
import { asyncHandler } from '@server/middleware';
import { sendOk, sendOkEmpty } from '@server/utils/http';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import type {
  SettingsOverrideRecord,
  SettingsRegistryRecord,
  SettingsValueRecord,
  SettingsValueType,
} from '@snaglet/shared/types';
import { logger } from '@server/config/logger';
import { registry } from '@server/services/settings/registry';
import {
  SettingsEntryError,
  settingsService,
  selectSettingOverride,
} from '@server/services/settings/settingsService';
import { agentSettings } from '@server/services/settings/categories/agent';
import { pruneOrphanedThreadSummaryModelOverrides } from '@server/services/settings/threadSummaryOverridePrune';
import type { SettingDef } from '@server/services/settings/defineSetting';

const router = Router();

const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const CATEGORY_RE = /^[a-z][a-z0-9_]*$/;

function inferValueType(value: unknown): SettingsValueType {
  if (value === null || value === undefined) return 'unknown';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'boolean' || t === 'number' || t === 'string' || t === 'object') {
    return t as SettingsValueType;
  }
  return 'unknown';
}

function buildUpdatedBy(
  userId: string | null,
  agentId: string | null
): SettingsOverrideRecord['updatedBy'] {
  if (userId != null) return { kind: 'user', id: userId };
  if (agentId != null) return { kind: 'agent', id: agentId };
  return null;
}

function actorFromReq(req: Request): { userId?: string; agentId?: string } {
  const raw = req.headers['x-snaglet-actor-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && value.trim() !== '') return { userId: value };
  return {};
}

function lookupDef(category: string, key: string): SettingDef<unknown> {
  if (!CATEGORY_RE.test(category)) {
    throw new AppError('Invalid category', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
  }
  if (!KEY_RE.test(key)) {
    throw new AppError('Invalid key', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
  }
  const def = registry.get(category, key);
  if (!def) {
    throw new AppError('Unknown setting', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }
  return def;
}

/**
 * settingsService rejects a value that fails the setting's zod schema with a
 * message containing "fails schema": that is the caller's bad input, so it is
 * a 400 carrying the detail. Any other failure is returned unchanged.
 */
function asSchemaRequestError(err: unknown, what: string): unknown {
  const msg = getErrorMessage(err);
  if (!/fails schema/.test(msg)) return err;
  return new AppError(
    `${what} does not match the setting schema: ${msg}`,
    ErrorCode.VALIDATION_ERROR,
    HTTP_STATUS.BAD_REQUEST
  );
}

/**
 * GET /api/settings
 *
 * List all override rows in the database. Does not include settings whose
 * value matches the registry default — those have no row to surface.
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await Settings.listAll();
    const out: SettingsOverrideRecord[] = rows.map((r) => ({
      category: r.category,
      key: r.key,
      value: r.value,
      updatedAt: r.updatedAt,
      updatedBy: buildUpdatedBy(r.updatedByUserId, r.updatedByAgentId),
    }));
    sendOk(res, out);
  })
);

/**
 * GET /api/settings/registry
 *
 * Every registered setting with its current value (override or default),
 * the registry default, type info, and override metadata. Drives the
 * admin UI in subtask 12.
 */
router.get(
  '/registry',
  asyncHandler(async (_req: Request, res: Response) => {
    const defs = registry.all();
    const allRows = await Settings.listAll();
    const rowByKey = new Map(allRows.map((r) => [`${r.category}.${r.key}`, r] as const));

    const out: SettingsRegistryRecord[] = defs.map((def) => {
      const row = selectSettingOverride(
        {
          ...def,
          key: `${def.category}.${def.key}`,
          legacyKey: def.legacyKey ? `${def.category}.${def.legacyKey}` : undefined,
        },
        rowByKey
      );
      const isOverridden = Boolean(row);
      return {
        category: def.category,
        key: def.key,
        description: def.description,
        valueType: inferValueType(def.default),
        default: def.default,
        current: row ? row.value : def.default,
        isOverridden,
        updatedAt: row ? row.updatedAt : null,
        updatedBy: row ? buildUpdatedBy(row.updatedByUserId, row.updatedByAgentId) : null,
      };
    });
    sendOk(res, out);
  })
);

/**
 * GET /api/settings/:category/:key
 *
 * One setting: its stored override as saved (like `GET /`), else the registry
 * default, and whether an override exists. For clients that follow a single
 * setting (the color theme re-reads `appearance/colors` on `settings:changed`).
 */
router.get(
  '/:category/:key',
  asyncHandler(async (req: Request, res: Response) => {
    const { category, key } = req.params as { category: string; key: string };
    const def = lookupDef(category, key);
    const row =
      (await Settings.read(def.category, def.key)) ??
      (def.legacyKey ? await Settings.read(def.category, def.legacyKey) : null);
    const out: SettingsValueRecord = {
      category,
      key,
      value: row ? row.value : def.default,
      isOverridden: Boolean(row),
    };
    sendOk(res, out);
  })
);

/**
 * PUT /api/settings/:category/:key
 *
 * Replace the value. Body: `{ value: <any JSON> }`. Validates via the
 * registered zod schema.
 */
router.put(
  '/:category/:key',
  asyncHandler(async (req: Request, res: Response) => {
    const { category, key } = req.params as { category: string; key: string };
    const def = lookupDef(category, key);
    const body = (req.body ?? {}) as { value?: unknown };
    if (!('value' in body)) {
      throw new AppError(
        'Request body must include `value`',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    let written: unknown;
    try {
      written = await settingsService.write(def, body.value, actorFromReq(req));
    } catch (err) {
      throw asSchemaRequestError(err, 'Value');
    }
    sendOk(res, { category, key, value: written });
  })
);

/**
 * PATCH /api/settings/:category/:key
 *
 * Shallow-merge `body.value` into the current value. Useful for object-
 * shaped settings (e.g. budget.group, the color theme) where the UI wants to
 * update a few fields without round-tripping the whole object. The merge runs
 * on the locked row (`settingsService.mergeEntries`), so a save here and an
 * agent's write to other fields at the same moment both keep theirs. For a
 * setting declared with `nullRemovesEntry` (the color theme), a null field
 * removes that entry; elsewhere null is stored as given. A setting declared
 * with `entryKeys` (the color theme's tokens) refuses any other field (400).
 *
 * Rejects when the setting isn't object-shaped.
 */
router.patch(
  '/:category/:key',
  asyncHandler(async (req: Request, res: Response) => {
    const { category, key } = req.params as { category: string; key: string };
    const def = lookupDef(category, key);
    const body = (req.body ?? {}) as { value?: unknown };
    if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) {
      throw new AppError(
        'PATCH body.value must be an object',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    let written: unknown;
    try {
      written = await settingsService.mergeEntries(
        def,
        body.value as Record<string, unknown>,
        actorFromReq(req)
      );
    } catch (err) {
      if (err instanceof SettingsEntryError) {
        // Not an object-shaped setting, or a key no map may hold (`__proto__`).
        throw new AppError(
          getErrorMessage(err),
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      throw asSchemaRequestError(err, 'Patched value');
    }
    sendOk(res, { category, key, value: written });
  })
);

/**
 * DELETE /api/settings/:category/:key
 *
 * Remove the override; revert to the registry default. Idempotent.
 */
router.delete(
  '/:category/:key',
  asyncHandler(async (req: Request, res: Response) => {
    const { category, key } = req.params as { category: string; key: string };
    const def = lookupDef(category, key);
    await settingsService.revert(def, actorFromReq(req));
    sendOkEmpty(res);
  })
);

function entryPath(req: Request): string[] {
  const { entry, subEntry } = req.params as { entry: string; subEntry?: string };
  return subEntry === undefined ? [entry] : [entry, subEntry];
}

/** Translate entry-level failures into 400s; anything else is a real error. */
function asEntryRequestError(err: unknown): unknown {
  if (err instanceof SettingsEntryError) {
    return new AppError(getErrorMessage(err), ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
  }
  return asSchemaRequestError(err, 'Entry');
}

/**
 * Entries keyed by a thread outlive a hard-deleted thread; edits to that map
 * are a cheap moment to drop them.
 */
async function pruneAfterEntryWrite(def: SettingDef<unknown>): Promise<void> {
  const threadDef = agentSettings.threadSummaryModelOverrides;
  if (def.category !== threadDef.category || def.key !== threadDef.key) return;
  try {
    await pruneOrphanedThreadSummaryModelOverrides();
  } catch (err) {
    logger.warn(`[settings] could not prune deleted threads' overrides: ${getErrorMessage(err)}`);
  }
}

/**
 * PUT /api/settings/:category/:key/entries/:entry[/:subEntry]
 *
 * Set one entry of a map-valued setting. Body: `{ value: <entry> }`. The
 * whole resulting map is schema-validated; the response carries it.
 */
const putEntry = asyncHandler(async (req: Request, res: Response) => {
  const { category, key } = req.params as { category: string; key: string };
  const def = lookupDef(category, key);
  const body = (req.body ?? {}) as { value?: unknown };
  if (!('value' in body) || body.value === undefined || body.value === null) {
    throw new AppError(
      'Request body must include a non-null `value`',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  let written: unknown;
  try {
    written = await settingsService.writeEntry(def, entryPath(req), body.value, actorFromReq(req));
  } catch (err) {
    throw asEntryRequestError(err);
  }
  await pruneAfterEntryWrite(def);
  sendOk(res, { category, key, value: written });
});

/**
 * DELETE /api/settings/:category/:key/entries/:entry[/:subEntry]
 *
 * Remove one entry (and any parent map it leaves empty). Idempotent; the
 * response carries the resulting map.
 */
const deleteEntry = asyncHandler(async (req: Request, res: Response) => {
  const { category, key } = req.params as { category: string; key: string };
  const def = lookupDef(category, key);
  let written: unknown;
  try {
    written = await settingsService.removeEntry(def, entryPath(req), actorFromReq(req));
  } catch (err) {
    throw asEntryRequestError(err);
  }
  await pruneAfterEntryWrite(def);
  sendOk(res, { category, key, value: written });
});

router.put('/:category/:key/entries/:entry', putEntry);
router.put('/:category/:key/entries/:entry/:subEntry', putEntry);
router.delete('/:category/:key/entries/:entry', deleteEntry);
router.delete('/:category/:key/entries/:entry/:subEntry', deleteEntry);

export default router;
