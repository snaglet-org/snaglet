import { describe, expect, it } from '@jest/globals';
import { generateCursorSpec } from '@snaglet/shared/cursor';
import { validateAgentCursorFields } from '@server/domains/agents/agentCursorValidation';

describe('validateAgentCursorFields', () => {
  it('accepts absent, null, known flowers and hex colors', () => {
    expect(() => validateAgentCursorFields({})).not.toThrow();
    expect(() =>
      validateAgentCursorFields({ cursorFlower: null, cursorColor: null })
    ).not.toThrow();
    expect(() =>
      validateAgentCursorFields({ cursorFlower: 'daisy', cursorColor: '#a1B2c3' })
    ).not.toThrow();
  });

  it('rejects unknown flowers and malformed colors', () => {
    expect(() => validateAgentCursorFields({ cursorFlower: 'cactus' })).toThrow();
    expect(() => validateAgentCursorFields({ cursorFlower: 3 })).toThrow();
    expect(() => validateAgentCursorFields({ cursorColor: 'red' })).toThrow();
    expect(() => validateAgentCursorFields({ cursorColor: '#fff' })).toThrow();
  });

  it('validates cursorSpec: null clears, a generated spec passes, junk is a 400', () => {
    expect(() => validateAgentCursorFields({ cursorSpec: null })).not.toThrow();
    expect(() => validateAgentCursorFields({ cursorSpec: generateCursorSpec(5) })).not.toThrow();
    expect(() => validateAgentCursorFields({ cursorSpec: { v: 1 } })).toThrow(/cursorSpec/);
    expect(() => validateAgentCursorFields({ cursorSpec: 'x' })).toThrow(/object/);
    const spec = generateCursorSpec(5);
    expect(() =>
      validateAgentCursorFields({ cursorSpec: { ...spec, pad: 'x'.repeat(5000) } })
    ).toThrow(/4096/);
  });
});
