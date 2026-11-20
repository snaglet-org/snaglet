/**
 * Credential pins — every place Snaglet remembers a credential id on the user's
 * behalf:
 *
 *   - `providers.primary_credential_id`
 *   - `agents.credential_id` and `thread_participants.credential_id`
 *   - `credentialId` inside `agent.summary_model_overrides` and
 *     `agent.thread_summary_model_overrides`
 *
 * A pin that outlives its credential breaks at call time: `pickSecret` refuses
 * to borrow another key for a pinned agent, and the summary resolver halts the
 * thread. So pins move together, in one transaction, whenever a credential is
 * deleted or superseded by a new Claude Code sign-in.
 *
 * The SQL is inline because the move spans four tables and a settings row and
 * must commit or roll back as one; the per-table models are not
 * transaction-aware.
 */

import { transaction } from '@snaglet/db';
import { logger } from '@server/config/logger';
import { emitAgentUpdated } from '@server/realtime/surfaces/agents';
import { settingsService } from '@server/services/settings';
import {
  agentSettings,
  type AgentSummaryModels,
  type SummaryModelRef,
  type ThreadAgentSummaryModels,
} from '@server/services/settings/categories/agent';
import { normalizeProviderId } from './normalization';

type Tx = Parameters<Parameters<typeof transaction>[0]>[0];

export interface CredentialPinChanges {
  /** Credential ids whose pins were moved. */
  fromCredentialIds: string[];
  /** Where those pins point now; null when they were cleared. */
  toCredential: { id: string; label: string } | null;
  /** The provider primary moved (or was filled). */
  providerPrimary: boolean;
  agentIds: string[];
  /** Threads whose per-thread agent model override was re-pointed. */
  threadParticipantThreadIds: string[];
  /** Agents whose summary-model override was re-pointed. */
  summaryOverrideAgentIds: string[];
  threadSummaryOverrides: Array<{ threadId: string; agentId: string }>;
}

export interface DeleteCredentialResult {
  deleted: { id: string; providerId: string; label: string };
  repointed: CredentialPinChanges;
}

interface RepointInput {
  providerId: string;
  fromCredentialIds: string[];
  /** Null clears the pins. */
  to: { id: string; label: string } | null;
  /** Also set the provider primary when it is currently empty. */
  fillEmptyPrimary: boolean;
}

export function hasPinChanges(changes: CredentialPinChanges): boolean {
  return (
    changes.providerPrimary ||
    changes.agentIds.length > 0 ||
    changes.threadParticipantThreadIds.length > 0 ||
    changes.summaryOverrideAgentIds.length > 0 ||
    changes.threadSummaryOverrides.length > 0
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One human sentence for logs, sign-in results and the Providers page. */
export function describePinChanges(changes: CredentialPinChanges): string {
  if (!hasPinChanges(changes)) return '';
  const parts: string[] = [];
  if (changes.providerPrimary) parts.push('the provider primary');
  if (changes.agentIds.length > 0) parts.push(plural(changes.agentIds.length, 'agent', 'agents'));
  if (changes.threadParticipantThreadIds.length > 0) {
    parts.push(
      plural(
        changes.threadParticipantThreadIds.length,
        'thread model override',
        'thread model overrides'
      )
    );
  }
  const summaryCount =
    changes.summaryOverrideAgentIds.length + changes.threadSummaryOverrides.length;
  if (summaryCount > 0) parts.push(plural(summaryCount, 'summary model', 'summary models'));
  const what = parts.join(', ');
  return changes.toCredential
    ? `Moved ${what} to "${changes.toCredential.label}".`
    : `Cleared the credential from ${what}; they now use the provider default.`;
}

function repointRef(
  ref: SummaryModelRef,
  from: ReadonlySet<string>,
  input: RepointInput
): SummaryModelRef | null {
  if (!ref.credentialId || !from.has(ref.credentialId)) return null;
  const sameProvider = normalizeProviderId(ref.providerId) === input.providerId;
  return { ...ref, credentialId: sameProvider && input.to ? input.to.id : null };
}

async function readSettingForUpdate(tx: Tx, key: string): Promise<unknown> {
  const { rows } = await tx.query<{ value: unknown }>(
    `SELECT value FROM public.settings WHERE category = 'agent' AND key = $1 FOR UPDATE`,
    [key]
  );
  return rows[0]?.value;
}

async function writeSetting(tx: Tx, key: string, value: unknown): Promise<void> {
  // A system write: clear the previous author so the row does not claim the
  // last person who edited it made this change.
  await tx.query(
    `UPDATE public.settings
        SET value = $2::jsonb, updated_at = now(),
            updated_by_user_id = NULL, updated_by_agent_id = NULL
      WHERE category = 'agent' AND key = $1`,
    [key, JSON.stringify(value)]
  );
}

async function repointSummaryOverrides(
  tx: Tx,
  from: ReadonlySet<string>,
  input: RepointInput
): Promise<string[]> {
  const def = agentSettings.summaryModelOverrides;
  const raw = await readSettingForUpdate(tx, def.key);
  if (raw === undefined) return [];
  const parsed = def.schema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(`[credential-pins] ${def.category}.${def.key} fails schema; left as is`);
    return [];
  }
  const next: AgentSummaryModels = { ...parsed.data };
  const changed: string[] = [];
  for (const [agentId, ref] of Object.entries(parsed.data)) {
    const moved = repointRef(ref, from, input);
    if (!moved) continue;
    next[agentId] = moved;
    changed.push(agentId);
  }
  if (changed.length > 0) await writeSetting(tx, def.key, next);
  return changed;
}

async function repointThreadSummaryOverrides(
  tx: Tx,
  from: ReadonlySet<string>,
  input: RepointInput
): Promise<Array<{ threadId: string; agentId: string }>> {
  const def = agentSettings.threadSummaryModelOverrides;
  const raw = await readSettingForUpdate(tx, def.key);
  if (raw === undefined) return [];
  const parsed = def.schema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(`[credential-pins] ${def.category}.${def.key} fails schema; left as is`);
    return [];
  }
  const next: ThreadAgentSummaryModels = {};
  const changed: Array<{ threadId: string; agentId: string }> = [];
  for (const [threadId, byAgent] of Object.entries(parsed.data)) {
    const nextByAgent = { ...byAgent };
    for (const [agentId, ref] of Object.entries(byAgent)) {
      const moved = repointRef(ref, from, input);
      if (!moved) continue;
      nextByAgent[agentId] = moved;
      changed.push({ threadId, agentId });
    }
    next[threadId] = nextByAgent;
  }
  if (changed.length > 0) await writeSetting(tx, def.key, next);
  return changed;
}

async function repointInTx(tx: Tx, input: RepointInput): Promise<CredentialPinChanges> {
  const fromIds = [...new Set(input.fromCredentialIds)].filter((id) => id !== input.to?.id);
  const from = new Set(fromIds);
  const toId = input.to?.id ?? null;
  const empty: CredentialPinChanges = {
    fromCredentialIds: fromIds,
    toCredential: input.to,
    providerPrimary: false,
    agentIds: [],
    threadParticipantThreadIds: [],
    summaryOverrideAgentIds: [],
    threadSummaryOverrides: [],
  };
  if (fromIds.length === 0 && !input.fillEmptyPrimary) return empty;

  const primary = await tx.query<{ id: string }>(
    `UPDATE public.providers
        SET primary_credential_id = $2, updated_at = NOW()
      WHERE id = $1
        AND (primary_credential_id = ANY($3::text[])
             OR ($4::boolean AND primary_credential_id IS NULL AND $2::text IS NOT NULL))
      RETURNING id`,
    [input.providerId, toId, fromIds, input.fillEmptyPrimary]
  );
  if (fromIds.length === 0) return { ...empty, providerPrimary: primary.rows.length > 0 };

  const agents = await tx.query<{ id: string }>(
    `UPDATE public.agents
        SET credential_id = $2, updated_at = NOW()
      WHERE credential_id = ANY($1::text[])
      RETURNING id`,
    [fromIds, toId]
  );
  const participants = await tx.query<{ thread_id: string }>(
    `UPDATE public.thread_participants
        SET credential_id = $2, updated_at = NOW()
      WHERE credential_id = ANY($1::text[])
      RETURNING thread_id`,
    [fromIds, toId]
  );

  return {
    ...empty,
    providerPrimary: primary.rows.length > 0,
    agentIds: agents.rows.map((row) => row.id),
    threadParticipantThreadIds: [...new Set(participants.rows.map((row) => row.thread_id))],
    summaryOverrideAgentIds: await repointSummaryOverrides(tx, from, input),
    threadSummaryOverrides: await repointThreadSummaryOverrides(tx, from, input),
  };
}

/** Caches and live windows catch up only after the transaction committed. */
function publish(changes: CredentialPinChanges, context: string): void {
  if (changes.summaryOverrideAgentIds.length > 0) {
    settingsService.invalidate('agent', agentSettings.summaryModelOverrides.key);
  }
  if (changes.threadSummaryOverrides.length > 0) {
    settingsService.invalidate('agent', agentSettings.threadSummaryModelOverrides.key);
  }
  for (const agentId of changes.agentIds) emitAgentUpdated(agentId, ['credentialId']);
  if (hasPinChanges(changes)) {
    logger.info(
      `[credential-pins] ${context}: ${describePinChanges(changes)} ` +
        `(from ${changes.fromCredentialIds.join(', ') || 'none'} → ` +
        `${changes.toCredential?.id ?? 'cleared'}; agents: ${changes.agentIds.join(', ') || 'none'})`
    );
  }
}

/**
 * Move every pin on `fromCredentialIds` to `toCredentialId` (a credential of
 * `providerId`). With `fillEmptyPrimary`, an empty provider primary is set too.
 */
export async function repointCredentialPins(input: {
  providerId: string;
  fromCredentialIds: string[];
  toCredentialId: string;
  fillEmptyPrimary?: boolean;
  context: string;
}): Promise<CredentialPinChanges> {
  const providerId = normalizeProviderId(input.providerId);
  const changes = await transaction(async (tx) => {
    const target = await tx.query<{ id: string; label: string; provider_id: string }>(
      `SELECT id, label, provider_id FROM public.user_provider_credentials WHERE id = $1 FOR SHARE`,
      [input.toCredentialId]
    );
    const row = target.rows[0];
    if (!row || normalizeProviderId(row.provider_id) !== providerId) {
      throw new Error(
        `Cannot re-point pins to credential ${input.toCredentialId}: it is not a ${providerId} credential`
      );
    }
    return repointInTx(tx, {
      providerId,
      fromCredentialIds: input.fromCredentialIds,
      to: { id: row.id, label: row.label },
      fillEmptyPrimary: input.fillEmptyPrimary ?? false,
    });
  });
  publish(changes, input.context);
  return changes;
}

/**
 * Delete a credential and, in the same transaction, move its pins to the
 * provider primary (or, when the deleted row was the primary, the best
 * remaining credential of that provider — same auth type first, never a row
 * whose last check failed ahead of one that did not). With no credential left
 * the pins are cleared, which means "use the provider default".
 *
 * Returns null when the credential does not exist.
 */
export async function deleteCredentialRepointingPins(
  credentialId: string
): Promise<DeleteCredentialResult | null> {
  const result = await transaction(async (tx) => {
    const found = await tx.query<{
      id: string;
      provider_id: string;
      label: string;
      auth_type_id: string | null;
    }>(
      `SELECT id, provider_id, label, auth_type_id
         FROM public.user_provider_credentials
        WHERE id = $1
        FOR UPDATE`,
      [credentialId]
    );
    const deleted = found.rows[0];
    if (!deleted) return null;
    const providerId = normalizeProviderId(deleted.provider_id);

    const replacement = await tx.query<{ id: string; label: string }>(
      `SELECT c.id, c.label
         FROM public.user_provider_credentials c
         LEFT JOIN public.providers p
           ON p.id = $1 AND p.primary_credential_id = c.id
        WHERE c.provider_id = $1 AND c.id <> $2
        ORDER BY (p.id IS NOT NULL) DESC,
                 (c.auth_type_id IS NOT DISTINCT FROM $3) DESC,
                 (c.verification_status = 'fail') ASC,
                 c.updated_at DESC, c.created_at DESC
        LIMIT 1`,
      [deleted.provider_id, deleted.id, deleted.auth_type_id]
    );
    const to = replacement.rows[0] ?? null;

    const repointed = await repointInTx(tx, {
      providerId,
      fromCredentialIds: [deleted.id],
      to: to ? { id: to.id, label: to.label } : null,
      fillEmptyPrimary: false,
    });
    await tx.query(`DELETE FROM public.user_provider_credentials WHERE id = $1`, [deleted.id]);
    return {
      deleted: { id: deleted.id, providerId, label: deleted.label },
      repointed,
    };
  });
  if (result) publish(result.repointed, `deleted credential ${result.deleted.id}`);
  return result;
}
