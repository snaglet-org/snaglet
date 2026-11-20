import {
  HEARTBEAT_TTL_MS,
  isSystemOverlayActive,
  markSystemOverlayAlive,
  resetSystemOverlay,
} from '@server/services/systemCursorOverlay';

describe('systemCursorOverlay', () => {
  beforeEach(() => resetSystemOverlay());

  it('is inactive until a heartbeat arrives', () => {
    expect(isSystemOverlayActive(0)).toBe(false);
    expect(isSystemOverlayActive(1_000_000)).toBe(false);
  });

  it('is active within the TTL and expires after it', () => {
    markSystemOverlayAlive(1000);
    expect(isSystemOverlayActive(1000)).toBe(true);
    expect(isSystemOverlayActive(1000 + HEARTBEAT_TTL_MS - 1)).toBe(true);
    expect(isSystemOverlayActive(1000 + HEARTBEAT_TTL_MS)).toBe(false);
  });

  it('a fresh heartbeat extends the window', () => {
    markSystemOverlayAlive(0);
    markSystemOverlayAlive(8000);
    expect(isSystemOverlayActive(15000)).toBe(true);
  });
});
