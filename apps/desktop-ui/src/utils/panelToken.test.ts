import { afterEach, describe, expect, it } from 'vitest';
import { getPanelJsonHeaders, setPanelToken } from './panelToken';

afterEach(() => {
  setPanelToken(null);
});

describe('getPanelJsonHeaders', () => {
  it('always includes the JSON content type and omits an unavailable token', () => {
    expect(getPanelJsonHeaders()).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('includes the current panel token when one has been delivered', () => {
    setPanelToken('the-panel-token');

    expect(getPanelJsonHeaders()).toEqual({
      'Content-Type': 'application/json',
      'X-Snaglet-Panel-Token': 'the-panel-token',
    });
  });
});
