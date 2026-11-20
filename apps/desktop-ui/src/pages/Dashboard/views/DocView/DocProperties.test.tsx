/**
 * DocProperties — a read-only metadata panel. A doc carries no task state
 * (tasks are Database table rows), so the panel is the header rail plus the
 * compact "Created by · date · Updated" attribution footer.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocProperties } from './DocProperties';
import {
  docsApi,
  membersApi,
  settingsApi,
  type DocRecord,
  type MemberOption,
} from '@desktop/utils/api';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import type { SettingsValueRecord } from '@snaglet/shared/types';

vi.mock('@desktop/utils/api', () => ({
  docsApi: {
    get: vi.fn(),
    update: vi.fn(),
  },
  membersApi: {
    list: vi.fn(),
  },
  settingsApi: {
    get: vi.fn(),
  },
}));

const get = vi.mocked(docsApi.get);
const update = vi.mocked(docsApi.update);
const list = vi.mocked(membersApi.list);
const getSetting = vi.mocked(settingsApi.get);

/** The `onboarding.seed` setting as the server returns it. */
function seedSetting(value: unknown): SettingsValueRecord {
  return { category: 'onboarding', key: 'seed', value, isOverridden: value !== null };
}

const baseDoc: DocRecord = {
  id: 'doc-1',
  containerId: null,
  title: 'Untitled',
  content: '',
  dueAt: null,
  assignedTo: null,
  priority: null,
  createdBy: null,
  lastEditedBy: null,
  sortOrder: 0,
  createdAt: '2026-01-01T12:00:00.000Z',
  updatedAt: '2026-01-01T12:00:00.000Z',
};

const members: MemberOption[] = [
  { id: 'member-1', kind: 'user', displayName: 'Ada' },
  { id: 'member-2', kind: 'agent', displayName: 'test-agent-a' },
];

function mockDoc(overrides: Partial<DocRecord> = {}): DocRecord {
  return { ...baseDoc, ...overrides };
}

async function renderExpanded(doc: DocRecord) {
  get.mockResolvedValue(doc);
  list.mockResolvedValue(members);
  render(<DocProperties docId={doc.id} />);
  // Loaded once the created date replaces its em dash.
  await waitFor(() => expect(info('Created')).not.toBe('—'));
}

/** The value shown next to an Info label, or null when the row is absent. */
function info(label: string): string | null {
  const dt = screen.queryAllByRole('term').find((el) => el.textContent === label);
  return dt?.nextElementSibling?.textContent ?? null;
}

beforeEach(() => {
  get.mockReset();
  update.mockReset();
  list.mockReset();
  getSetting.mockReset();
  getSetting.mockResolvedValue(seedSetting(null));
  window.localStorage.clear();
});

describe('DocProperties — no task fields on a doc', () => {
  it('renders no Work item group or editable field, even for a doc in a container', async () => {
    await renderExpanded(mockDoc({ containerId: 'container-1' }));
    expect(screen.queryByText('Work item')).toBeNull();
    expect(screen.queryByLabelText('Due date')).toBeNull();
    expect(screen.queryByLabelText('Priority')).toBeNull();
    expect(screen.queryByLabelText('Assignee')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('never shows a Completed segment (completion is table-row state, not doc state)', async () => {
    await renderExpanded(mockDoc());
    expect(screen.queryByText(/^Completed /)).toBeNull();
  });
});

describe('DocProperties — save state', () => {
  it('renders the editor save state in the metadata live region', async () => {
    get.mockResolvedValue(mockDoc());
    list.mockResolvedValue(members);
    render(<DocProperties docId="doc-1" editorSaveState="dirty" />);
    expect(await screen.findByRole('status')).toHaveTextContent('unsaved');
  });
});

describe('DocProperties — Info list', () => {
  it('lists creator, created date and update recency', async () => {
    await renderExpanded(mockDoc({ createdBy: 'member-1' }));
    await waitFor(() => expect(info('Created by')).toBe('Ada'));
    expect(info('Created')).toBe('Jan 1, 2026');
    expect(info('Updated')).toBe('Jan 1');
  });

  it('follows a newer updatedAt from the pane instead of the record fetched on open', async () => {
    get.mockResolvedValue(mockDoc());
    list.mockResolvedValue(members);
    const { rerender } = render(<DocProperties docId="doc-1" updatedAt={baseDoc.updatedAt} />);
    await waitFor(() => expect(info('Updated')).toBe('Jan 1'));

    rerender(<DocProperties docId="doc-1" updatedAt="2026-02-03T12:00:00.000Z" />);
    expect(info('Updated')).toBe('Feb 3');
    // An older pane value never rolls the stamp back.
    rerender(<DocProperties docId="doc-1" updatedAt="2025-12-01T12:00:00.000Z" />);
    expect(info('Updated')).toBe('Jan 1');
  });

  it('falls back to an em dash when the creator is unknown', async () => {
    await renderExpanded(mockDoc({ createdBy: null }));
    expect(info('Created by')).toBe('—');
  });

  it('omits the Edited by row when lastEditedBy is unset', async () => {
    await renderExpanded(mockDoc({ lastEditedBy: null }));
    expect(info('Edited by')).toBeNull();
  });

  it('adds an Edited by row when lastEditedBy is set', async () => {
    await renderExpanded(mockDoc({ lastEditedBy: 'member-1' }));
    await waitFor(() => expect(info('Edited by')).toBe('Ada'));
  });
});

describe('DocProperties — Edited by follows saves (doc-saved)', () => {
  const saved = (overrides: { id?: string; lastEditedBy?: string } = {}) =>
    act(() => {
      emitLibraryEvent({
        type: 'doc-saved',
        id: overrides.id ?? baseDoc.id,
        content: 'Saved body',
        updatedAt: '2026-01-02T12:00:00.000Z',
        ...(overrides.lastEditedBy ? { lastEditedBy: overrides.lastEditedBy } : {}),
      });
    });

  it('switches Edited by to the editor a save names', async () => {
    await renderExpanded(mockDoc({ lastEditedBy: 'member-1' }));
    await waitFor(() => expect(info('Edited by')).toBe('Ada'));

    saved({ lastEditedBy: 'member-2' });
    expect(info('Edited by')).toBe('test-agent-a');
  });

  it('shows Edited by once a save names an editor for a never-edited doc', async () => {
    await renderExpanded(mockDoc({ lastEditedBy: null }));
    expect(info('Edited by')).toBeNull();

    saved({ lastEditedBy: 'member-1' });
    await waitFor(() => expect(info('Edited by')).toBe('Ada'));
  });

  it('keeps the current Edited by when a save names no editor', async () => {
    await renderExpanded(mockDoc({ lastEditedBy: 'member-1' }));
    saved({ lastEditedBy: 'member-2' });
    saved();
    expect(info('Edited by')).toBe('test-agent-a');
  });

  it("ignores another doc's saves", async () => {
    await renderExpanded(mockDoc({ lastEditedBy: 'member-1' }));
    saved({ id: 'doc-2', lastEditedBy: 'member-2' });
    await waitFor(() => expect(info('Edited by')).toBe('Ada'));
  });
});

describe('DocProperties — who created the doc', () => {
  it('says Snaglet made a starter doc the first-run seed lists', async () => {
    getSetting.mockResolvedValue(
      seedSetting({ status: 'done', docs: { 'welcome-to-snaglet': 'doc-1' } })
    );
    await renderExpanded(mockDoc({ id: 'doc-1', createdBy: null }));

    await waitFor(() => expect(info('Created by')).toBe('Snaglet'));
    expect(getSetting).toHaveBeenCalledWith('onboarding', 'seed');
  });

  it('keeps the dash for an authorless doc the seed did not make', async () => {
    getSetting.mockResolvedValue(
      seedSetting({ status: 'done', docs: { 'welcome-to-snaglet': 'doc-9' } })
    );
    await renderExpanded(mockDoc({ id: 'doc-1', createdBy: null }));

    await waitFor(() => expect(getSetting).toHaveBeenCalled());
    expect(info('Created by')).toBe('—');
  });

  it('names the member who created the doc without reading the seed record', async () => {
    await renderExpanded(mockDoc({ createdBy: 'member-1' }));

    await waitFor(() => expect(info('Created by')).toBe('Ada'));
    expect(getSetting).not.toHaveBeenCalled();
  });
});
