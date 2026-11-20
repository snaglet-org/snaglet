import {
  describeHostMachine,
  formatHostMachine,
} from '@server/services/SystemPromptComposer/hostMachine';

const GIB = 1024 ** 3;

describe('formatHostMachine', () => {
  it('describes an Apple Silicon Mac with its chip, RAM and shell', () => {
    expect(
      formatHostMachine({
        platform: 'darwin',
        arch: 'arm64',
        release: '24.0.0',
        cpuModel: 'Apple M1',
        cpuCount: 8,
        totalMemBytes: 16 * GIB,
        shell: 'zsh',
      })
    ).toBe(
      'a Mac (Apple Silicon) running macOS (kernel 24.0.0, arm64), Apple M1, 8 cores, 16 GB RAM; default shell zsh'
    );
  });

  it('names Windows and Linux, and copes with missing CPU model and shell', () => {
    const base = {
      arch: 'x64',
      release: '10.0',
      cpuModel: null,
      cpuCount: 1,
      totalMemBytes: 8 * GIB,
      shell: null,
    };
    expect(formatHostMachine({ ...base, platform: 'win32' })).toBe(
      'a Windows PC running Windows (kernel 10.0, x64), 1 core, 8 GB RAM'
    );
    expect(formatHostMachine({ ...base, platform: 'linux' })).toContain(
      'a Linux machine running Linux'
    );
  });
});

describe('describeHostMachine', () => {
  it('is memoized and carries no live figures (cache-stable)', () => {
    const first = describeHostMachine();
    expect(describeHostMachine()).toBe(first);
    expect(first).toMatch(/GB RAM/);
    expect(first).not.toMatch(/free|uptime|load/i);
  });
});
