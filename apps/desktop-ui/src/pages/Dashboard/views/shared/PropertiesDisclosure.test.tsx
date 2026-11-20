import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PropertiesDisclosure } from './PropertiesDisclosure';

const propertiesScss = readFileSync(
  resolve(process.cwd(), 'src/pages/Dashboard/views/shared/NodeProperties.module.scss'),
  'utf8'
);

describe('PropertiesDisclosure', () => {
  it('uses the shared inset card and floats its expanded body over pane content', () => {
    const onToggle = vi.fn();
    render(
      <PropertiesDisclosure
        ariaLabel="Test properties"
        expanded
        onToggle={onToggle}
        header={<span>Header metadata</span>}
      >
        <span>Property fields</span>
      </PropertiesDisclosure>
    );

    const region = screen.getByRole('region', { name: 'Test properties' });
    const body = screen.getByText('Property fields').parentElement;

    expect(region.parentElement?.className).toContain('host');
    expect(body?.className).toContain('overlayBody');
    expect(propertiesScss.match(/\.host\s*\{([^}]+)\}/)?.[1]).toContain('padding: 10px 12px 0');
    expect(propertiesScss.match(/\.overlayBody\s*\{([^}]+)\}/)?.[1]).toContain(
      'position: absolute'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Properties' }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('supports embedded, in-flow disclosures without duplicating the component', () => {
    const { container } = render(
      <PropertiesDisclosure
        ariaLabel="Embedded properties"
        expanded
        onToggle={() => undefined}
        inset={false}
        overlay={false}
      >
        <span>Embedded fields</span>
      </PropertiesDisclosure>
    );

    const region = screen.getByRole('region', { name: 'Embedded properties' });
    const body = screen.getByText('Embedded fields').parentElement;

    expect(container.firstElementChild).toBe(region);
    expect(body?.className).not.toContain('overlayBody');
  });
});
