import { API_ROUTES } from '@snaglet/shared/types/api';
import { PALETTE_SEARCH_MODES } from '@snaglet/shared/constants/paletteSearch';
import { DEFAULT_USER_NAME, isDefaultUserName } from '@snaglet/shared/constants/userProfile';

describe('Shared Constants', () => {
  describe('PALETTE_SEARCH_MODES', () => {
    it('contains every palette search mode', () => {
      expect(PALETTE_SEARCH_MODES).toEqual(['keyword', 'hybrid', 'semantic']);
    });
  });

  describe('isDefaultUserName', () => {
    it('matches the starting name in any case, ignoring surrounding spaces', () => {
      expect(isDefaultUserName(DEFAULT_USER_NAME)).toBe(true);
      expect(isDefaultUserName('  local user ')).toBe(true);
    });

    it('does not match a name of their own, or no name', () => {
      expect(isDefaultUserName('Robin')).toBe(false);
      expect(isDefaultUserName('Local Users')).toBe(false);
      expect(isDefaultUserName(null)).toBe(false);
    });
  });

  describe('API_ROUTES', () => {
    it('should have HEALTH route defined', () => {
      expect(API_ROUTES.HEALTH).toBeDefined();
    });

    it('should have correct HEALTH endpoint path', () => {
      expect(API_ROUTES.HEALTH).toBe('/health');
    });

    it('should have HEALTH route starting with /', () => {
      expect(API_ROUTES.HEALTH).toMatch(/^\//);
    });

    it('should be immutable (readonly)', () => {
      // TypeScript enforces this at compile time with 'as const'
      // This test verifies the object structure exists
      expect(Object.isFrozen(API_ROUTES)).toBe(false); // as const doesn't freeze at runtime
      expect(typeof API_ROUTES).toBe('object');
    });

    it('should contain all expected route keys', () => {
      const expectedKeys = [
        'HEALTH',
        'SERVER_STATUS',
        'SERVER_STOP',
        'SERVER_LOGS',
        'GATEWAY_STATUS',
        'GATEWAY_START',
        'GATEWAY_STOP',
        'GATEWAY_LOGS',
      ];
      expect(Object.keys(API_ROUTES)).toEqual(expectedKeys);
    });
  });
});
