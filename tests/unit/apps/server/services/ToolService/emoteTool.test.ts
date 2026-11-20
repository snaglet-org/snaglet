jest.mock('@server/services/ToolService/tools/system/computer/tool', () => ({
  emitAvatarEmote: jest.fn(),
}));
import tool from '@server/services/ToolService/tools/system/emote/tool';
import { emitAvatarEmote } from '@server/services/ToolService/tools/system/computer/tool';
import { AVATAR_EMOTES } from '@snaglet/shared/constants/agentCursor';
const emit = jest.mocked(emitAvatarEmote);
const run = (input: Record<string, unknown>, agentId = 'fixture-agent') =>
  tool(input, {}, { agentId } as never);
beforeEach(() => {
  emit.mockReset();
  emit.mockResolvedValue(true);
});
it.each(AVATAR_EMOTES)('plays %s only for caller', async (animation) => {
  expect(JSON.parse((await run({ animation })) as string)).toMatchObject({ ok: true, animation });
  expect(emit).toHaveBeenCalledWith('fixture-agent', animation, undefined, undefined);
});
it('rejects invalid animation and caption', async () => {
  await expect(run({ animation: 'delete' })).rejects.toThrow('Choose');
  await expect(run({ animation: 'spin', reason: 'x'.repeat(201) })).rejects.toThrow('200');
  expect(emit).not.toHaveBeenCalled();
});
it('accepts the angry shake animation and the new expressions, and still rejects bad names', async () => {
  expect(AVATAR_EMOTES).toContain('angry');
  expect(JSON.parse((await run({ animation: 'angry' })) as string)).toMatchObject({
    ok: true,
    animation: 'angry',
  });
  expect(JSON.parse((await run({ emotion: 'embarrassed' })) as string)).toMatchObject({
    ok: true,
    emotion: 'embarrassed',
  });
  expect(JSON.parse((await run({ emotion: 'annoyed' })) as string)).toMatchObject({
    ok: true,
    emotion: 'annoyed',
  });
  await expect(run({ animation: 'furious' })).rejects.toThrow('Choose');
  await expect(run({ emotion: 'furious' })).rejects.toThrow('Unknown emotion');
});
it('names the new options in the tool definition', async () => {
  const { default: definition } =
    await import('@server/services/ToolService/tools/system/emote/definition');
  const props = (
    definition.parameters_schema as { properties: Record<string, { enum?: string[] }> }
  ).properties;
  expect(props.animation.enum).toContain('angry');
  expect(definition.description).toMatch(/angry/);
  expect(definition.description).toMatch(/embarrassed/);
  expect(definition.description).toMatch(/annoyed/);
});
it('requires identity', async () => {
  await expect(run({ animation: 'spin' }, '')).rejects.toThrow('calling agent');
});
it('reports missing position honestly', async () => {
  emit.mockResolvedValue(false);
  expect(JSON.parse((await run({ animation: 'cry' })) as string)).toMatchObject({
    ok: false,
    error: expect.stringContaining('point first'),
  });
});

it('combines an existing expression with movement', async () => {
  await run({ animation: 'spin', emotion: 'curious' });
  expect(emit).toHaveBeenCalledWith('fixture-agent', 'spin', undefined, 'curious');
  await expect(run({ animation: 'spin', emotion: 'invalid' })).rejects.toThrow('Unknown emotion');
});

it.each([
  'neutral',
  'happy',
  'thinking',
  'focused',
  'curious',
  'surprised',
  'sleepy',
  'worried',
  'proud',
  'stumped',
  'angry',
  'embarrassed',
  'annoyed',
])('allows expression-only %s', async (emotion) => {
  const reply = JSON.parse((await run({ emotion })) as string);
  expect(reply).toMatchObject({ ok: true, emotion });
  expect(emit).toHaveBeenCalledWith('fixture-agent', undefined, undefined, emotion);
});
it('rejects an empty request', async () => {
  await expect(run({})).rejects.toThrow('Choose an emotion');
});
it('still rejects unknown expressions next to the new ones', async () => {
  await expect(run({ emotion: 'furious' })).rejects.toThrow('Unknown emotion');
  expect(emit).not.toHaveBeenCalled();
});
it('lets the new expressions combine with an animation', async () => {
  await run({ emotion: 'angry', animation: 'hyper' });
  expect(emit).toHaveBeenCalledWith('fixture-agent', 'hyper', undefined, 'angry');
});
it('advertises the new expressions in the tool schema', async () => {
  const { default: definition } =
    await import('@server/services/ToolService/tools/system/emote/definition');
  const props = (
    definition.parameters_schema as { properties: Record<string, { enum?: string[] }> }
  ).properties;
  expect(props.emotion.enum).toEqual(expect.arrayContaining(['angry', 'embarrassed', 'annoyed']));
});
