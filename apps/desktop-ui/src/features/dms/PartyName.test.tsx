import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PartyName } from './PartyName';

describe('PartyName', () => {
  it('adds (you) only for the person', () => {
    const { container, rerender } = render(<PartyName name="Test User" isYou />);
    expect(container).toHaveTextContent('Test User (you)');
    rerender(<PartyName name="Test Agent A" />);
    expect(container).toHaveTextContent('Test Agent A');
    expect(screen.queryByText(/\(you\)/)).toBeNull();
  });
});
