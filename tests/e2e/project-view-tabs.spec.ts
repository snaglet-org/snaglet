import { test, expect } from '@playwright/test';
import { openApp, gotoLibrary } from './helpers/nav';
import {
  createContainer,
  deleteContainer,
  openNodeViaPalette,
  runPrefix,
  type ContainerRec,
} from './helpers/workspace';

/**
 * Project container surface.
 *
 * The Overview / Contents pane-chrome tabs this spec originally reproduced
 * were intentionally removed: ContainerView now says "No tabs — the grid is
 * the single surface, so the chrome carries only the icon/list view toggle."
 * A project's facets live behind the Properties disclosure (and the project
 * DetailsPanel) instead of a separate Overview tab. The kanban "Tasks" tab
 * stays gone.
 *
 * Current contract asserted here for a `category === 'project'` container:
 *   - the pane chrome carries the Icon/List "View mode" segmented control
 *   - a Properties disclosure trigger renders atop the grid
 *   - the container is badged as a Project
 *   - no Tasks / Overview / Contents tabs render anywhere in the pane chrome
 */

test.describe('Project container surface (no tabs; properties + view toggle)', () => {
  // Self-contained: the spec creates its own project container instead of
  // depending on a pre-existing "Snaglet" project in whichever workspace it runs
  // against (a fresh workspace has no such container).
  let project: ContainerRec | null = null;

  test.afterAll(async () => {
    await deleteContainer(project?.id);
  });

  test('opening a project container shows the grid chrome without legacy tabs', async ({
    page,
  }) => {
    project = await createContainer({ name: runPrefix('project-tabs'), category: 'project' });

    await openApp(page);
    await gotoLibrary(page);

    // Open the created project via the palette — no dependence on sidebar
    // tree expansion state or pre-existing rows.
    await openNodeViaPalette(page, project.name);

    const main = page.locator('main').first();

    // Pane chrome: the icon/list view toggle is the only segmented control.
    const viewMode = main.getByRole('radiogroup', { name: 'View mode' });
    await expect(viewMode, 'View mode toggle should render for a container').toBeVisible({
      timeout: 10_000,
    });
    await expect(viewMode.getByRole('radio', { name: 'Icon view' })).toBeVisible();
    await expect(viewMode.getByRole('radio', { name: 'List view' })).toBeVisible();

    // Properties disclosure + Project badge sit atop the grid.
    await expect(
      main.getByRole('button', { name: 'Properties' }),
      'Properties disclosure should render atop the grid'
    ).toBeVisible();
    await expect(
      main.getByText('Project', { exact: true }).first(),
      'project badge should render for a project container'
    ).toBeVisible();

    // The project view is a single grid: no Tasks, Overview or Contents tabs.
    await expect(main.getByText(/^Tasks$/i), 'Tasks tab must be gone').toHaveCount(0);
    await expect(main.getByText(/^Overview$/i), 'Overview tab must be gone').toHaveCount(0);
    await expect(main.getByText(/^Contents$/i), 'Contents tab must be gone').toHaveCount(0);
  });
});
