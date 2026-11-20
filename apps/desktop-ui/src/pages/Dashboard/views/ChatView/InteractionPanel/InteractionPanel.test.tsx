/**
 * InteractionPanel — the drag-to-resize handle hands the page back.
 *
 * A drag turns off text selection on the page and listens on the window
 * until it ends. It must end on a canceled pointer and when the panel
 * closes mid-drag (the request was answered elsewhere or timed out), or the
 * whole app is left unable to select text.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InteractionPanel } from './InteractionPanel';

function renderPanel() {
  return render(
    <InteractionPanel title="$ test" resizeLabel="Resize test panel" footer={null}>
      body
    </InteractionPanel>
  );
}

afterEach(() => {
  document.body.style.userSelect = '';
});

describe('InteractionPanel — resize drag', () => {
  it('restores text selection when the pointer is released', () => {
    renderPanel();
    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize test panel' }));
    expect(document.body.style.userSelect).toBe('none');

    fireEvent.pointerUp(window);
    expect(document.body.style.userSelect).toBe('');
  });

  it('restores text selection when the pointer is canceled', () => {
    renderPanel();
    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize test panel' }));

    fireEvent.pointerCancel(window);
    expect(document.body.style.userSelect).toBe('');
  });

  it('restores text selection when the panel closes mid-drag', () => {
    const { unmount } = renderPanel();
    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize test panel' }));

    unmount();
    expect(document.body.style.userSelect).toBe('');
  });
});
