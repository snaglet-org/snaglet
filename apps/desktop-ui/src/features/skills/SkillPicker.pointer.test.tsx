/**
 * The skill picker highlights a skill on hover only after the pointer really
 * moves: skills that appear or shift under a resting pointer must not take
 * Enter from the first addable one.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SkillInfo } from '@desktop/utils/api/skills';
import { SkillPicker } from './SkillPicker';

function skill(id: string, slug: string): SkillInfo {
  return {
    id,
    slug,
    name: slug,
    description: `${slug} skill`,
    status: 'valid',
    error: null,
    sourcePath: `/skills/${slug}/SKILL.md`,
    folderPath: `/skills/${slug}`,
    version: null,
    indexedAt: '2026-11-16T00:00:00.000Z',
  };
}

const SKILLS = [skill('s1', 'research-alpha'), skill('s2', 'research-beta')];

function openPicker() {
  const onChange = vi.fn();
  render(<SkillPicker skills={SKILLS} selected={[]} onChange={onChange} label="Skills" />);
  const input = screen.getByRole('combobox', { name: 'Add to Skills' });
  fireEvent.click(input);
  return { input, onChange };
}

const option = (name: RegExp) => screen.getByRole('option', { name });

/** What a browser sends when options appear or move under a resting pointer. */
function contentAppearsUnder(element: HTMLElement, clientX: number, clientY: number) {
  fireEvent.mouseOver(element, { clientX, clientY });
  fireEvent.mouseEnter(element, { clientX, clientY });
  fireEvent.mouseMove(element, { clientX, clientY });
  fireEvent.mouseMove(element, { clientX, clientY });
}

function moveAcross(element: HTMLElement) {
  fireEvent.mouseMove(element, { clientX: 100, clientY: 80 });
  fireEvent.mouseMove(element, { clientX: 104, clientY: 83 });
}

describe('SkillPicker: a pointer that has not moved', () => {
  it('cannot take the highlight, so Enter adds the first skill', () => {
    const { input, onChange } = openPicker();

    contentAppearsUnder(option(/research-beta/), 100, 80);
    expect(option(/research-alpha/)).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['s1']);
  });

  it('cannot take it after the search changes either', () => {
    const { input, onChange } = openPicker();
    moveAcross(option(/research-beta/));
    expect(option(/research-beta/)).toHaveAttribute('aria-selected', 'true');

    fireEvent.change(input, { target: { value: 'research' } });
    contentAppearsUnder(option(/research-beta/), 104, 83);
    expect(option(/research-beta/)).toHaveAttribute('aria-selected', 'false');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['s1']);
  });

  it('still follows a real move and the arrow keys, and a press adds the pressed skill', () => {
    const { input, onChange } = openPicker();
    moveAcross(option(/research-beta/));
    expect(option(/research-beta/)).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(option(/research-alpha/)).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['s2']);

    fireEvent.click(input);
    fireEvent.mouseDown(option(/research-alpha/));
    expect(onChange).toHaveBeenLastCalledWith(['s1']);
  });
});
