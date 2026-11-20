import { afterEach, describe, expect, it } from '@jest/globals';
import { ConflictError } from '@snaglet/shared/utils';
import { hookExecutionCoordinator } from '@server/services/customHooks/HookExecutionCoordinator';

afterEach(() => hookExecutionCoordinator.reset());

describe('HookExecutionCoordinator', () => {
  it('counts queued and active invocations before allowing a destructive reservation', () => {
    expect(hookExecutionCoordinator.begin('digest')).toBe(true);
    expect(hookExecutionCoordinator.begin('digest')).toBe(true);
    expect(hookExecutionCoordinator.reserve('digest')).toBe(false);

    hookExecutionCoordinator.end('digest');
    expect(hookExecutionCoordinator.reserve('digest')).toBe(false);
    hookExecutionCoordinator.end('digest');
    expect(hookExecutionCoordinator.reserve('digest')).toBe(true);
  });

  it('blocks every new invocation until a reservation is released', () => {
    hookExecutionCoordinator.reserveOrThrow('digest');
    expect(hookExecutionCoordinator.begin('digest')).toBe(false);
    expect(() => hookExecutionCoordinator.reserveOrThrow('digest')).toThrow(ConflictError);

    hookExecutionCoordinator.release('digest');
    expect(hookExecutionCoordinator.begin('digest')).toBe(true);
  });

  it('isolates independent hook names', () => {
    expect(hookExecutionCoordinator.begin('alpha')).toBe(true);
    expect(hookExecutionCoordinator.reserve('beta')).toBe(true);
    expect(hookExecutionCoordinator.begin('beta')).toBe(false);
    expect(hookExecutionCoordinator.reserve('alpha')).toBe(false);
  });
});
