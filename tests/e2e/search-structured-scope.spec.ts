import { expect, test } from '@playwright/test';
import { openApp } from './helpers/nav';
import {
  createContainer,
  createDoc,
  deleteContainer,
  deleteDoc,
  runPrefix,
  type ContainerRec,
  type DocRec,
} from './helpers/workspace';

test.describe('Cmd+K structured scope', () => {
  const prefix = runPrefix('scope');
  // One alphanumeric lexeme so PostgreSQL FTS treats it as a positive term;
  // hyphenated run prefixes can be parsed as websearch operators.
  const token = `${prefix.replace(/[^a-z0-9]/gi, '')}needle`;
  let snagletProject: ContainerRec;
  let otherProject: ContainerRec;
  let target: DocRec;
  let decoy: DocRec;

  test.beforeAll(async () => {
    snagletProject = await createContainer({ name: `${prefix}-Snaglet`, category: 'project' });
    otherProject = await createContainer({ name: `${prefix}-Other`, category: 'project' });
    target = await createDoc({ title: `${token}-target`, containerId: snagletProject.id });
    decoy = await createDoc({ title: `${token}-decoy`, containerId: otherProject.id });
  });

  test.afterAll(async () => {
    await deleteDoc(target?.id);
    await deleteDoc(decoy?.id);
    await deleteContainer(snagletProject?.id);
    await deleteContainer(otherProject?.id);
  });

  test('strict named scope removes decoys and dropping the scope restores them', async ({
    page,
  }) => {
    await openApp(page);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const dialog = page.getByRole('dialog', { name: 'Quick search' });
    const input = dialog.getByRole('textbox', { name: 'Quick search' });

    const strictQuery = `${token} in ${snagletProject.name}`;
    const strictResponse = page.waitForResponse((response) => {
      if (!response.url().endsWith('/api/search/palette')) return false;
      const body = response.request().postDataJSON() as { query?: string; mode?: string };
      return body.query === strictQuery && body.mode === 'keyword';
    });
    await input.fill(strictQuery);
    const strictBody = (await (await strictResponse).json()) as {
      data: {
        executionPlan: { scopePolicy: string; scopeLabel?: string; query: string };
        byKind: { doc?: Array<{ node_id: string }> };
      };
    };

    expect(strictBody.data.executionPlan).toMatchObject({
      scopePolicy: 'strict',
      scopeLabel: snagletProject.name,
      query: token,
    });
    expect(strictBody.data.byKind.doc?.map((hit) => hit.node_id)).toContain(target.id);
    expect(strictBody.data.byKind.doc?.map((hit) => hit.node_id)).not.toContain(decoy.id);
    await expect(dialog.getByText(`Scope: ${snagletProject.name}`)).toBeVisible();
    await expect(dialog.getByRole('option', { name: target.title })).toBeVisible();
    await expect(dialog.getByRole('option', { name: decoy.title })).toHaveCount(0);

    // There is no hidden query inference: no 'cross_project' policy and no
    // phrase-stripping.
    // Dropping the "in <project>" scope is what restores cross-project hits:
    // a bare token query executes NEUTRAL over the whole workspace.
    const globalQuery = token;
    const globalResponse = page.waitForResponse((response) => {
      if (!response.url().endsWith('/api/search/palette')) return false;
      const body = response.request().postDataJSON() as { query?: string; mode?: string };
      return body.query === globalQuery && body.mode === 'keyword';
    });
    await input.fill(globalQuery);
    const globalBody = (await (await globalResponse).json()) as {
      data: {
        executionPlan: { scopePolicy: string; query: string };
        byKind: { doc?: Array<{ node_id: string }> };
      };
    };
    expect(globalBody.data.executionPlan).toMatchObject({
      scopePolicy: 'neutral',
      query: token,
    });
    expect(globalBody.data.byKind.doc?.map((hit) => hit.node_id)).toEqual(
      expect.arrayContaining([target.id, decoy.id])
    );
    await expect(dialog.getByRole('option', { name: target.title })).toBeVisible();
    await expect(dialog.getByRole('option', { name: decoy.title })).toBeVisible();

    // There is no temporal inference from bare query words — the palette
    // plan hardcodes timeRange: null / ordering: relevance. Temporal words are
    // plain search terms: no timeLabel, no reordering, no phrase-stripping.
    const temporalQuery = `${token} today`;
    const temporalResponse = page.waitForResponse((response) => {
      if (!response.url().endsWith('/api/search/palette')) return false;
      const body = response.request().postDataJSON() as { query?: string; mode?: string };
      return body.query === temporalQuery && body.mode === 'keyword';
    });
    await input.fill(temporalQuery);
    const temporalBody = (await (await temporalResponse).json()) as {
      data: {
        executionPlan: { timeLabel?: string; ordering: string; query: string };
        byKind: { doc?: Array<{ node_id: string }> };
      };
    };
    expect(temporalBody.data.executionPlan.timeLabel).toBeUndefined();
    expect(temporalBody.data.executionPlan.ordering).toBe('relevance');
    expect(temporalBody.data.executionPlan.query).toBe(temporalQuery);
    await expect(dialog.getByText('Time: today')).toHaveCount(0);
    await expect(dialog.getByText('Newest updated')).toHaveCount(0);
  });
});
