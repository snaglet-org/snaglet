import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, toolsApi: { ...actual.toolsApi, get: mocks.get } };
});
vi.mock('./useWorkspaceAncestors', () => ({ useWorkspaceAncestors: () => [] }));
vi.mock('@desktop/pages/Dashboard/views/ToolView', () => ({
  ToolView: ({ tool }: { tool: { id: string } }) => <div data-testid="tool-view">{tool.id}</div>,
}));

it('renders a slug tool reference as a tool chip that opens the tool preview', async () => {
  mocks.get.mockResolvedValue({ id: 'weather_today', name: 'Weather today' });
  const { container } = render(
    <MarkdownRenderer content="Ask [Weather today](tool:weather_today) first." />
  );

  const chip = container.querySelector('.md-chip.md-chip-tool');
  expect(chip).not.toBeNull();
  expect(chip?.getAttribute('data-node-id')).toBe('weather_today');
  expect(chip?.querySelector('.md-chip-title')?.textContent).toBe('Weather today');
  expect(container.querySelector('a[target="_blank"]')).toBeNull();

  fireEvent.click(chip as Element);
  expect(await screen.findByTestId('tool-view')).toHaveTextContent('weather_today');
  expect(mocks.get).toHaveBeenCalledWith('weather_today');
});
