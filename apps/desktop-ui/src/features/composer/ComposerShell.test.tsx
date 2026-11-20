import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ComposerNotice, ComposerShell } from './ComposerShell';

describe('ComposerShell', () => {
  it('lays out header, attachments, editor, notices and both action slots in one bubble', () => {
    render(
      <ComposerShell
        data-testid="bubble"
        header={<span>Header slot</span>}
        attachments={<span>Thumb</span>}
        attachmentsLabel="Attached images"
        notices={<ComposerNotice tone="error">Upload failed</ComposerNotice>}
        leadingActions={<button type="button">Attach</button>}
        trailingActions={<button type="button">Send</button>}
        actionsTestId="actions"
      >
        <textarea aria-label="Editor" />
      </ComposerShell>
    );
    const bubble = screen.getByTestId('bubble');
    const order = [
      screen.getByText('Header slot'),
      screen.getByRole('group', { name: 'Attached images' }),
      screen.getByLabelText('Editor'),
      screen.getByRole('alert'),
      screen.getByTestId('actions'),
    ];
    order.forEach((el) => expect(bubble).toContainElement(el));
    for (let i = 1; i < order.length; i += 1) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
    const actions = screen.getByTestId('actions');
    expect(within(actions).getByRole('button', { name: 'Attach' })).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('omits empty slots', () => {
    render(
      <ComposerShell data-testid="bubble" attachments={false}>
        <textarea aria-label="Editor" />
      </ComposerShell>
    );
    expect(screen.getByTestId('bubble').children).toHaveLength(1);
  });

  it('gives info notices a status role and the rest an alert role', () => {
    render(
      <>
        <ComposerNotice>Just so you know</ComposerNotice>
        <ComposerNotice tone="warning" actions={<button type="button">Fix</button>}>
          Needs a decision
        </ComposerNotice>
      </>
    );
    expect(screen.getByRole('status')).toHaveTextContent('Just so you know');
    expect(screen.getByRole('alert')).toHaveTextContent('Needs a decision');
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Fix' })).toBeVisible();
  });
});
