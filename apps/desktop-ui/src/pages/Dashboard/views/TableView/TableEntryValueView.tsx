import { useState } from 'react';
import type {
  RelatedTableEntries,
  RelatedTableItems,
  TableEntryValue,
  TableField,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { CopyToClipboardButton } from '@desktop/components/CopyToClipboardButton';
import { MarkdownRenderer } from '@desktop/features/rich-markdown/renderer';
import { MAX_TRANSCLUSION_DEPTH } from '@desktop/features/rich-markdown/renderer/TransclusionBlock';
import { EntryReferenceChip } from '@desktop/features/table-entries';
import { SnagletReferenceChip } from '@desktop/features/table-entries/SnagletReferenceChip';
import { CheckboxCellValue } from './cells/CheckboxCellValue';
import { SelectOptionTag } from './SelectOptionTag';
import { entryValueList } from './entryValueList';
import { rangeKindOf } from './dateRange';
import { dateRangeText, singleDateText } from './dateRangeText';
import styles from './TableEntries.module.scss';
import relationStyles from './RelationEntryPicker.module.scss';

function EntryIdentity({ id }: { id: string }) {
  const [copyError, setCopyError] = useState<string | null>(null);
  const shortId = id.slice(0, 8);
  return (
    <>
      <CopyToClipboardButton
        value={id}
        className={styles.identityCopy}
        idleTitle={id}
        aria-label={`Copy full entry ID ${shortId}`}
        idleContent={shortId}
        copiedContent="Copied"
        onCopySuccess={() => setCopyError(null)}
        onCopyError={(error) => setCopyError(getErrorMessage(error, 'Could not copy the entry ID'))}
      />
      {copyError && <span role="alert">{copyError}</span>}
    </>
  );
}

export function TableEntryValueView({
  field,
  value,
  relatedEntries,
  relatedItems,
  untitledLabel = 'Untitled',
  interactive = false,
}: {
  field?: TableField;
  value: TableEntryValue;
  relatedEntries?: RelatedTableEntries;
  /** Titles of linked Snaglet items; archived ones show muted, purged ones as unavailable. */
  relatedItems?: RelatedTableItems;
  /** An empty Name's positional label, such as "Untitled 3". */
  untitledLabel?: string;
  /** Relation chips open their entries; only outside another control. */
  interactive?: boolean;
}) {
  if (field?.type === 'checkbox')
    return <CheckboxCellValue checked={value === true} label={field.name} />;
  if (field?.isTitle && (value === null || (typeof value === 'string' && !value.trim())))
    return <span className={relationStyles.untitled}>{untitledLabel}</span>;
  if (value === null) return null;
  if (field?.type === 'select') {
    const labels = entryValueList(value);
    return (
      <span className={styles.selectValues}>
        {labels.map((label) => (
          <SelectOptionTag
            key={label}
            label={label}
            color={field.options?.find((option) => option.label === label)?.color}
          />
        ))}
      </span>
    );
  }
  if (field?.managed && field.columnName === 'id' && typeof value === 'string')
    return <EntryIdentity id={value} />;
  const rangeKind = rangeKindOf(field);
  if (rangeKind && typeof value === 'string') {
    const range = dateRangeText(value, rangeKind);
    if (range)
      return (
        <span title={range.label}>
          <span aria-hidden="true">{range.text}</span>
          <span className={styles.srOnly}>{range.label}</span>
        </span>
      );
  }
  if ((field?.type === 'date' || field?.type === 'datetime') && typeof value === 'string') {
    const single = singleDateText(value, field.type);
    if (single)
      return (
        <time dateTime={value} title={single.label}>
          {single.text}
        </time>
      );
  }
  if (field?.type === 'text')
    return (
      <MarkdownRenderer
        className={styles.cellMarkdown}
        content={String(value)}
        depth={MAX_TRANSCLUSION_DEPTH}
        showIncludeToggle={false}
      />
    );
  if (field?.type === 'relation' && field.referenceKind) {
    const kind = field.referenceKind;
    return (
      <span className={relationStyles.readValues}>
        {entryValueList(value).map((id) => (
          <SnagletReferenceChip
            key={id}
            kind={kind}
            id={id}
            relatedItems={relatedItems}
            interactive={interactive}
            draggable={interactive}
          />
        ))}
      </span>
    );
  }
  if (field?.type === 'relation' && field.referenceTableId) {
    const tableId = field.referenceTableId;
    const ids = entryValueList(value);
    return (
      <span className={relationStyles.readValues}>
        {ids.map((entryId) => (
          <EntryReferenceChip
            key={entryId}
            tableId={tableId}
            entryId={entryId}
            name={relatedEntries?.[tableId]?.[entryId]?.name}
            interactive={interactive}
            draggable={interactive}
          />
        ))}
      </span>
    );
  }
  return <span>{String(value)}</span>;
}
