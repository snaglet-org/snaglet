import { describe, it, expect } from 'vitest';
import { CHIP_URL_RE, CHIP_PREFIXED_ID_RE } from './helpers';

describe('Image chip parsing helpers', () => {
  describe('CHIP_URL_RE', () => {
    it('matches scheme-prefixed image chip URLs', () => {
      const match = CHIP_URL_RE.exec('image:image-123');
      expect(match).toBeTruthy();
      expect(match?.[1]).toBe('image');
      expect(match?.[2]).toBe('image-123');
    });

    it('matches scheme-prefixed doc chip URLs', () => {
      const match = CHIP_URL_RE.exec('page:doc-456');
      expect(match).toBeTruthy();
      expect(match?.[1]).toBe('page');
      expect(match?.[2]).toBe('doc-456');
    });

    it('matches scheme-prefixed container chip URLs', () => {
      const match = CHIP_URL_RE.exec('container:uuid-789');
      expect(match).toBeTruthy();
      expect(match?.[1]).toBe('container');
      expect(match?.[2]).toBe('uuid-789');
    });

    it('does not match HTTP URLs', () => {
      const match = CHIP_URL_RE.exec('https://example.com');
      expect(match).toBeNull();
    });

    it('does not match plain IDs without scheme', () => {
      const match = CHIP_URL_RE.exec('image-123');
      expect(match).toBeNull();
    });
  });

  describe('CHIP_PREFIXED_ID_RE', () => {
    it('matches prefixed image kind IDs', () => {
      const match = CHIP_PREFIXED_ID_RE.exec('image-123');
      expect(match).toBeTruthy();
      expect(match?.[1]).toBe('image');
      expect(match?.[2]).toBe('123');
    });

    it('matches prefixed page kind IDs', () => {
      const match = CHIP_PREFIXED_ID_RE.exec('page-456');
      expect(match).toBeTruthy();
      expect(match?.[1]).toBe('page');
      expect(match?.[2]).toBe('456');
    });

    it('matches prefixed container kind IDs', () => {
      const match = CHIP_PREFIXED_ID_RE.exec('container-uuid-789');
      expect(match).toBeTruthy();
      expect(match?.[1]).toBe('container');
      expect(match?.[2]).toBe('uuid-789');
    });

    it('does not match scheme-prefixed URLs', () => {
      const match = CHIP_PREFIXED_ID_RE.exec('page:doc-456');
      expect(match).toBeNull();
    });

    it('does not match HTTP URLs', () => {
      const match = CHIP_PREFIXED_ID_RE.exec('https://example.com');
      expect(match).toBeNull();
    });
  });
});
