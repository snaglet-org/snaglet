import { describe, expect, it, jest } from '@jest/globals';
import { sweepAppleSidecarOrphans } from '@server/services/voice/appleSidecarCleanup';

describe('sweepAppleSidecarOrphans', () => {
  it('matches resolved binaries and kills valid stale pids only', () => {
    const kill = jest.fn();
    const pgrep = jest.fn(() => '1\n42\n999\nnot-a-pid\n');
    sweepAppleSidecarOrphans(['/opt/snaglet/apple-stt', '/opt/snaglet/apple-tts'], {
      exists: () => true,
      pgrep,
      kill,
      selfPid: 999,
    });

    expect(pgrep).toHaveBeenNthCalledWith(1, '/opt/snaglet/apple-stt');
    expect(pgrep).toHaveBeenNthCalledWith(2, '/opt/snaglet/apple-tts');
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenNthCalledWith(1, 42);
    expect(kill).toHaveBeenNthCalledWith(2, 42);
  });

  it('does not invoke pgrep for missing binaries and tolerates exited processes', () => {
    const kill = jest.fn(() => {
      throw new Error('already gone');
    });
    const pgrep = jest.fn(() => '55\n');
    sweepAppleSidecarOrphans(['/missing'], {
      exists: () => false,
      pgrep,
      kill,
      selfPid: 999,
    });
    expect(pgrep).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();

    sweepAppleSidecarOrphans(['/present'], {
      exists: () => true,
      pgrep,
      kill,
      selfPid: 999,
    });
    expect(kill).toHaveBeenCalledWith(55);
  });
});
