import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableField } from '@snaglet/shared/types';
import { TableEntryValueView } from './TableEntryValueView';

const chip = vi.hoisted(() => vi.fn());
const markdown = vi.hoisted(() => vi.fn());
vi.mock('@desktop/features/table-entries', () => ({
  EntryReferenceChip: (props: { entryId: string; name?: string }) => {
    chip(props);
    return (
      <span title={props.entryId}>
        {props.name === undefined ? 'Unresolved entry' : props.name.trim() || 'Untitled'}
      </span>
    );
  },
}));
vi.mock('@desktop/features/rich-markdown/renderer', () => ({
  MarkdownRenderer: (props: { content: string }) => {
    markdown(props);
    return <span>{props.content}</span>;
  },
}));
vi.mock('@desktop/features/rich-markdown/renderer/TransclusionBlock', () => ({
  MAX_TRANSCLUSION_DEPTH: 5,
}));

const tableId = 'table-1111111111111-aaaaaaaaa';
const targetId = 'table-1111111111111-bbbbbbbbb';
const entryId = '00000000-0000-4000-8000-000000000001';
const nextEntryId = '00000000-0000-4000-8000-000000000002';
const title: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId: targetId,
  columnName: 'f_aaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'Title',
  type: 'text',
  description: null,
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: null,
  position: 2,
  managed: false,
  collapsed: false,
  isTitle: false,
  multiple: false,
  options: null,
  revision: 1,
};
const relation: TableField = { ...title, tableId, type: 'relation', referenceTableId: targetId };
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('TableEntryValueView', () => {
  it('renders select labels as quiet tags in stored order, not reference chips', () => {
    const field: TableField = {
      ...title,
      type: 'select',
      multiple: true,
      options: [
        { id: 'opt-first', label: 'First', color: 'blue' },
        { id: 'opt-second', label: 'Second', color: 'green' },
      ],
    };
    const view = render(<TableEntryValueView field={field} value={['Second', 'First']} />);
    expect(view.container).toHaveTextContent('SecondFirst');
    expect(screen.getByTitle('Second')).toHaveTextContent('Second');
    expect(chip).not.toHaveBeenCalled();
    expect(markdown).not.toHaveBeenCalled();
    view.rerender(<TableEntryValueView field={field} value={[]} />);
    expect(view.container).toHaveTextContent('');
  });

  it('shows a short managed ID but copies the full identity', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(
      <TableEntryValueView
        field={{ ...title, managed: true, columnName: 'id', type: 'uuid' }}
        value={entryId}
      />
    );
    const button = screen.getByRole('button', {
      name: `Copy full entry ID ${entryId.slice(0, 8)}`,
    });
    expect(button).toHaveTextContent(entryId.slice(0, 8));
    expect(button).toHaveAttribute('title', entryId);
    await user.click(button);
    expect(copy).toHaveBeenCalledWith(entryId);
    expect(button).toHaveTextContent('Copied');
  });

  it.each([true, false])(
    'renders datetime fields (managed=%s) as local dates while preserving their exact machine value',
    (managed) => {
      const value = '2026-09-26T17:02:16.832699Z';
      render(
        <TableEntryValueView
          field={{
            ...title,
            managed,
            columnName: managed ? 'created_at' : 'scheduled_at',
            type: 'datetime',
          }}
          value={value}
        />
      );
      const formatted = new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(value));
      expect(screen.getByText(formatted)).toHaveAttribute('datetime', value);
      expect(screen.queryByText(value)).not.toBeInTheDocument();
    }
  );

  it.each([true, false])(
    'shows the year only for non-current-year datetime values (managed=%s)',
    (managed) => {
      const field: TableField = { ...title, type: 'datetime', managed };
      const view = render(<TableEntryValueView field={field} value="2025-09-26T17:02:00Z" />);
      expect(view.container.querySelector('time')).toHaveTextContent('2025');
      view.rerender(<TableEntryValueView field={field} value="2026-09-26T17:02:00Z" />);
      expect(view.container.querySelector('time')).not.toHaveTextContent('2026');
      expect(view.container.querySelector('time')).toHaveAttribute(
        'datetime',
        '2026-09-26T17:02:00Z'
      );
      view.rerender(<TableEntryValueView field={field} value="2027-09-26T17:02:00Z" />);
      expect(view.container.querySelector('time')).toHaveTextContent('2027');
    }
  );

  it('shows a date range compactly with the full range as its title and spoken text', () => {
    const field: TableField = { ...title, type: 'date', range: true };
    const view = render(<TableEntryValueView field={field} value="2026-10-12/2026-10-15" />);
    const shown = screen.getByText('Oct 12 – 15');
    expect(shown).toHaveAttribute('aria-hidden', 'true');
    expect(shown.parentElement).toHaveAttribute('title', 'October 12 to October 15');
    expect(screen.getByText('October 12 to October 15')).toBeInTheDocument();
    view.rerender(<TableEntryValueView field={field} value="2026-10-30/2026-11-02" />);
    expect(screen.getByText('Oct 30 – Nov 2')).toBeInTheDocument();
  });

  it('shows a datetime range in the viewer zone', () => {
    const options = Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...options,
      timeZone: 'America/Los_Angeles',
    });
    render(
      <TableEntryValueView
        field={{ ...title, type: 'datetime', range: true }}
        value="2026-10-12T16:00:00.000000Z/2026-10-13T00:00:00.000000Z"
      />
    );
    expect(screen.getByText('Oct 12, 9:00 AM – 5:00 PM')).toBeInTheDocument();
    expect(screen.getByText('October 12, 9:00 AM to 5:00 PM')).toBeInTheDocument();
    vi.mocked(Intl.DateTimeFormat.prototype.resolvedOptions).mockRestore();
  });

  it('shows a single date as the date field reads it, never the stored ISO', () => {
    const field: TableField = { ...title, type: 'date' };
    const view = render(<TableEntryValueView field={field} value="2026-10-12" />);
    const shown = screen.getByText('Mon, Oct 12');
    expect(shown).toHaveAttribute('datetime', '2026-10-12');
    expect(shown).toHaveAttribute('title', 'Monday, October 12, 2026');
    expect(screen.queryByText('2026-10-12')).not.toBeInTheDocument();
    view.rerender(<TableEntryValueView field={field} value="2025-10-12" />);
    expect(screen.getByText('Sun, Oct 12, 2025')).toBeInTheDocument();
    // Text that isn't a date stays as stored.
    view.rerender(<TableEntryValueView field={field} value="2026-02-30" />);
    expect(screen.getByText('2026-02-30')).toBeInTheDocument();
    expect(document.querySelector('time')).toBeNull();
  });

  it('shows a single value of a range field as a plain date or time shows', () => {
    const view = render(
      <TableEntryValueView field={{ ...title, type: 'date', range: true }} value="2026-10-12" />
    );
    expect(screen.getByText('Mon, Oct 12')).toHaveAttribute('datetime', '2026-10-12');
    view.rerender(
      <TableEntryValueView
        field={{ ...title, type: 'datetime', range: true }}
        value="2026-09-26T17:02:00Z"
      />
    );
    expect(view.container.querySelector('time')).toHaveAttribute(
      'datetime',
      '2026-09-26T17:02:00Z'
    );
  });

  it('does not silently normalize invalid datetime values into a different calendar date', () => {
    render(<TableEntryValueView field={{ ...title, type: 'datetime' }} value="2026-02-30T12:30" />);
    expect(screen.getByText('2026-02-30T12:30')).toBeInTheDocument();
    expect(document.querySelector('time')).toBeNull();
  });

  it('keeps null, false, empty text and exact numeric strings distinct', () => {
    const view = render(<TableEntryValueView field={title} value={null} />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<TableEntryValueView field={{ ...title, type: 'checkbox' }} value={false} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    view.rerender(<TableEntryValueView field={{ ...title, type: 'checkbox' }} value={true} />);
    expect(screen.getByRole('checkbox')).toBeChecked();
    view.rerender(
      <TableEntryValueView field={{ ...title, type: 'number' }} value="9007199254740993.01" />
    );
    expect(screen.getByText('9007199254740993.01')).toBeInTheDocument();
    view.rerender(<TableEntryValueView field={title} value="" />);
    expect(screen.queryByText('—')).not.toBeInTheDocument();
    expect(markdown).toHaveBeenLastCalledWith(expect.objectContaining({ content: '' }));
  });

  it('renders text references without recursively expanding node contents', () => {
    const content = '[Field guide](doc-1111111111111-aaaaaaaaa)';
    render(<TableEntryValueView field={title} value={content} />);
    expect(markdown).toHaveBeenCalledWith({
      content,
      depth: 5,
      showIncludeToggle: false,
      className: expect.any(String),
    });
  });

  it('uses relatedEntries names and leaves live refresh to the shared noninteractive chip', () => {
    const view = render(
      <TableEntryValueView
        field={relation}
        value={entryId}
        relatedEntries={{
          [targetId]: { [entryId]: { name: 'Related record' } },
          [tableId]: { [entryId]: { name: 'Wrong table' } },
        }}
      />
    );
    expect(screen.getByText('Related record')).toHaveAttribute('title', entryId);
    expect(chip).toHaveBeenLastCalledWith({
      tableId: targetId,
      entryId,
      name: 'Related record',
      interactive: false,
      draggable: false,
    });
    view.rerender(
      <TableEntryValueView
        field={relation}
        value={entryId}
        relatedEntries={{ [targetId]: { [entryId]: { name: 'Renamed' } } }}
      />
    );
    expect(screen.getByText('Renamed')).toBeInTheDocument();
  });

  it('lets relation chips open and drag their entries outside another control', () => {
    render(<TableEntryValueView field={relation} value={entryId} interactive />);
    expect(chip).toHaveBeenLastCalledWith(
      expect.objectContaining({ entryId, interactive: true, draggable: true })
    );
  });

  it('leaves missing targets unresolved rather than inventing their names', () => {
    render(<TableEntryValueView field={relation} value={entryId} />);
    expect(chip).toHaveBeenLastCalledWith(
      expect.objectContaining({ tableId: targetId, entryId, name: undefined })
    );
  });

  it('renders ordered multiple relations, unnamed targets and empty lists', () => {
    const view = render(
      <TableEntryValueView
        field={{ ...relation, multiple: true }}
        value={[nextEntryId, entryId]}
        relatedEntries={{
          [targetId]: { [entryId]: { name: 'Second' }, [nextEntryId]: { name: '' } },
        }}
      />
    );
    expect(view.container.textContent).toBe('UntitledSecond');
    expect(view.container.querySelectorAll('button')).toHaveLength(0);
    view.rerender(<TableEntryValueView field={{ ...relation, multiple: true }} value={[]} />);
    expect(view.container.textContent).toBe('');
  });

  it('shows Untitled only for empty title fields without rewriting their value', () => {
    const view = render(<TableEntryValueView field={{ ...title, isTitle: true }} value={null} />);
    expect(screen.getByText('Untitled')).toBeInTheDocument();
    view.rerender(<TableEntryValueView field={{ ...title, isTitle: true }} value="  " />);
    expect(screen.getByText('Untitled')).toBeInTheDocument();
    view.rerender(
      <TableEntryValueView
        field={{ ...title, isTitle: true }}
        value=""
        untitledLabel="Untitled 7"
      />
    );
    expect(screen.getByText('Untitled 7')).toBeInTheDocument();
    view.rerender(
      <TableEntryValueView
        field={{ ...title, isTitle: true }}
        value="Named"
        untitledLabel="Untitled 7"
      />
    );
    expect(screen.queryByText('Untitled 7')).not.toBeInTheDocument();
    expect(markdown).toHaveBeenCalledTimes(1);
  });
});
