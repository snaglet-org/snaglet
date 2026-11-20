import { useEffect, useState } from 'react';
import type { TableField } from '@snaglet/shared/types';
import { subscribeTableEvents } from '@desktop/features/database';
import { tablesApi } from '@desktop/utils/api';

/**
 * The table's active fields, for the Calendar and Repeats choices (end time
 * fields, status fields). Reloads when the table's fields change. Null while
 * loading or when `enabled` is false; a failed load leaves it null, and the
 * server still checks every choice.
 */
export function useTableFields(tableId: string, enabled: boolean): TableField[] | null {
  const [fields, setFields] = useState<TableField[] | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    return subscribeTableEvents((event) => {
      if (event.type === 'table.fields.changed' && event.tableId === tableId)
        setNonce((n) => n + 1);
    });
  }, [enabled, tableId]);

  useEffect(() => {
    if (!enabled) return;
    let canceled = false;
    tablesApi
      .fields(tableId)
      .then(({ fields: list }) => {
        if (!canceled) setFields(list);
      })
      .catch((err: unknown) => {
        // Keep the last list; choices fall back to what the field already names.
        console.error('Could not load table fields for the field editor', err);
      });
    return () => {
      canceled = true;
    };
  }, [enabled, tableId, nonce]);

  return enabled ? fields : null;
}
