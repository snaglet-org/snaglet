/**
 * ProjectPaneSection — a long project-pane list shows its first rows and folds
 * the rest behind "Show all N"; a row the caller pins (the one being renamed)
 * stays on screen while folded.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PROJECT_SECTION_PREVIEW, ProjectPaneSection } from './ProjectPaneSection';

const items = Array.from({ length: PROJECT_SECTION_PREVIEW + 3 }, (_, i) => `Row ${i + 1}`);

function renderSection(
  sectionItems: readonly string[] | null,
  keepVisible?: (item: string) => boolean
) {
  render(
    <ProjectPaneSection
      title="Threads"
      items={sectionItems}
      empty="Nothing here."
      keepVisible={keepVisible}
    >
      {(visible) => (
        <ul>
          {visible.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </ProjectPaneSection>
  );
}

const rowTexts = () => screen.getAllByRole('listitem').map((row) => row.textContent);

it('folds a long list after its preview rows and toggles the rest', () => {
  renderSection(items);
  expect(rowTexts()).toEqual(items.slice(0, PROJECT_SECTION_PREVIEW));
  const toggle = screen.getByRole('button', { name: `Show all ${items.length}` });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');

  fireEvent.click(toggle);
  expect(rowTexts()).toEqual(items);
  expect(toggle).toHaveTextContent('Show less');
  expect(toggle).toHaveAttribute('aria-expanded', 'true');

  fireEvent.click(toggle);
  expect(rowTexts()).toEqual(items.slice(0, PROJECT_SECTION_PREVIEW));
});

it('keeps a pinned row on screen while folded, in its place', () => {
  const last = items[items.length - 1];
  renderSection(items, (item) => item === last);
  expect(rowTexts()).toEqual([...items.slice(0, PROJECT_SECTION_PREVIEW), last]);
});

it('shows a list that fits its preview whole, with no toggle', () => {
  renderSection(items.slice(0, PROJECT_SECTION_PREVIEW));
  expect(rowTexts()).toHaveLength(PROJECT_SECTION_PREVIEW);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('shows the empty line and no count while the list is unknown', () => {
  renderSection(null);
  expect(screen.getByRole('region', { name: 'Threads' })).toHaveTextContent(
    /^ThreadsNothing here\.$/
  );
});
