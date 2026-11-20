import { Containers } from '@snaglet/db/tables/containers';
import { Threads } from '@snaglet/db/tables/threads';
import { Images } from '@snaglet/db/tables/images';
import { getDb } from '@snaglet/db';
import { resolveAgentImageContainer } from '@server/services/ToolService/lib/resolveAgentImageContainer';

jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeCreated: jest.fn(),
  snapshotFromContainer: jest.fn((row: unknown) => row),
}));

// Each integration file runs against an isolated PostgreSQL clone.
describe('agent image initial placement', () => {
  it('serializes concurrent requests and reuses a project Images folder', async () => {
    const project = await Containers.create({ name: 'Placement test', category: 'project' });
    const nested = await Containers.create({ name: 'Nested', parentId: project.id });
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => resolveAgentImageContainer(undefined, nested.id))
    );
    expect(new Set(ids).size).toBe(1);
    expect(await Containers.findById(ids[0]!)).toMatchObject({
      name: 'Images',
      parentId: project.id,
    });
    expect(
      (await Containers.listByParent(project.id)).filter((c) => c.name === 'Images')
    ).toHaveLength(1);
  });

  it('resolves project and flat threads and chooses the nearest nested project', async () => {
    const outer = await Containers.create({ name: 'Outer image scope', category: 'project' });
    const inner = await Containers.create({
      name: 'Inner image scope',
      category: 'project',
      parentId: outer.id,
    });
    const thread = await Threads.create({
      id: 'thread-image-placement-project',
      title: 'Image placement thread',
      projectId: inner.id,
    });
    const folder = await resolveAgentImageContainer(thread.id);
    expect(await Containers.findById(folder)).toMatchObject({ parentId: inner.id });
    const flat = await Threads.create({
      id: 'thread-image-placement-flat',
      title: 'Flat image thread',
    });
    expect(await resolveAgentImageContainer(flat.id)).toBe(await resolveAgentImageContainer());
  });

  it('uses root Images without project scope, including folders outside projects', async () => {
    const folder = await Containers.create({ name: 'Unscoped source' });
    const root = await resolveAgentImageContainer();
    expect(await resolveAgentImageContainer(undefined, folder.id)).toBe(root);
    expect(await Containers.findById(root)).toMatchObject({ name: 'Images', parentId: null });
  });

  it('reuses case-insensitive names and keeps projects isolated', async () => {
    const project = await Containers.create({
      name: 'Other placement project',
      category: 'project',
    });
    const images = await Containers.create({ name: 'images', parentId: project.id });
    expect(await resolveAgentImageContainer(undefined, project.id)).toBe(images.id);
    expect(await resolveAgentImageContainer()).not.toBe(images.id);
  });

  it('rejects missing scopes and does not swallow missing thread errors', async () => {
    await expect(resolveAgentImageContainer(undefined, 'missing-image-scope')).rejects.toThrow();
    await expect(resolveAgentImageContainer('missing-image-thread')).rejects.toThrow();
  });

  it('leaves manually moved images alone on subsequent creation and human uploads untouched', async () => {
    const target = await Containers.create({ name: 'Manual destination' });
    const folder = await resolveAgentImageContainer();
    const image = await Images.createImage({
      id: 'image-placement-manual',
      name: 'test',
      containerId: folder,
      mimeType: 'image/png',
      data: Buffer.from('fixture'),
      sizeBytes: 7,
    });
    await getDb().query('UPDATE public.nodes SET container_id=$1 WHERE id=$2', [
      target.id,
      image.id,
    ]);
    await resolveAgentImageContainer();
    expect((await Images.findImageById(image.id))?.containerId).toBe(target.id);
    const human = await Images.createImage({
      id: 'image-placement-human',
      name: 'upload',
      containerId: target.id,
      mimeType: 'image/png',
      data: Buffer.from('fixture'),
      sizeBytes: 7,
    });
    expect(human.containerId).toBe(target.id);
  });
});
