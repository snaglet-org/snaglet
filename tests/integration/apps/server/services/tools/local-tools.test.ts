import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'fs/promises';
import diffFilesTool from '@server/services/ToolService/tools/files/fileDiff';
import generateChartTool from '@server/services/ToolService/tools/media/generate-chart/tool';
import pdfGenerateTool from '@server/services/ToolService/tools/media/pdf-generate/tool';
import pdfExtractTool from '@server/services/ToolService/tools/media/pdf-extract/tool';
import gitCommitTool from '@server/services/ToolService/handlers/integrations/git/commit';
import gitTool from '@server/services/ToolService/tools/integrations/github/git/tool';
import { resolveToolId, transformToolAliasParams } from '@snaglet/shared/utils';

const execFileAsync = promisify(execFile);

describe('tool-local integration coverage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'snaglet-local-tools-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('diff-files returns a unified diff for two text files', async () => {
    const left = path.join(tmpDir, 'left.txt');
    const right = path.join(tmpDir, 'right.txt');
    await writeFile(left, 'alpha\nbeta\n', 'utf8');
    await writeFile(right, 'alpha\ngamma\n', 'utf8');

    const result = await diffFilesTool({ left, right, contextLines: 1 }, { root_dir: tmpDir });

    expect(result).toContain('left.txt');
    expect(result).toContain('right.txt');
    expect(result).toContain('-beta');
    expect(result).toContain('+gamma');
  });

  it('generate-chart returns SVG markup with the supplied title and labels', async () => {
    const result = await generateChartTool(
      {
        type: 'bar',
        title: 'Build Times',
        data: {
          labels: ['fast', 'slow'],
          datasets: [{ label: 'duration', values: [3, 7] }],
        },
      },
      {}
    );

    expect(result.startsWith('<svg')).toBe(true);
    expect(result).toContain('Build Times');
    expect(result).toContain('fast');
    expect(result).toContain('slow');
  });

  it('pdf-generate writes a PDF that pdf-extract can read back', async () => {
    const pdfPath = path.join(tmpDir, 'report.pdf');

    const generateResult = await pdfGenerateTool(
      {
        content: 'Quarterly report\nLine item 1',
        outputPath: pdfPath,
        contentType: 'markdown',
      },
      { root_dir: tmpDir }
    );

    expect(generateResult).toContain('PDF saved');

    const pdfStat = await stat(pdfPath);
    expect(pdfStat.size).toBeGreaterThan(0);

    const extracted = await pdfExtractTool(
      {
        source: pdfPath,
        includeMetadata: false,
      },
      { root_dir: tmpDir }
    );

    const parsed = JSON.parse(extracted) as {
      pageCount: number;
      selectedPages: number[];
      text: string;
    };

    expect(parsed.pageCount).toBeGreaterThanOrEqual(1);
    expect(parsed.selectedPages).toContain(1);
    expect(parsed.text).toContain('Quarterly report');
    expect(parsed.text).toContain('Line item 1');
    // Generous per-test timeout: PDF generate+extract (font/layout work) can
    // intermittently exceed the default 5s under parallel test load.
  }, 30000);

  it('git-commit creates a real commit in a temporary repository', async () => {
    await execFileAsync('git', ['init', '-q'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'snaglet-tests@example.com'], {
      cwd: tmpDir,
    });
    await execFileAsync('git', ['config', 'user.name', 'Snaglet Tests'], { cwd: tmpDir });

    const filePath = path.join(tmpDir, 'note.txt');
    await writeFile(filePath, 'first commit\n', 'utf8');

    const result = await gitCommitTool(
      {
        cwd: tmpDir,
        files: ['note.txt'],
        message: 'Add note',
      },
      {}
    );

    expect(result).toContain('Committed');
    expect(result).toContain('Add note');

    const log = await execFileAsync('git', ['log', '-1', '--pretty=%s'], { cwd: tmpDir });
    expect(log.stdout.trim()).toBe('Add note');
  });

  it('git-commit reports when there are no staged changes to commit', async () => {
    await execFileAsync('git', ['init', '-q'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'snaglet-tests@example.com'], {
      cwd: tmpDir,
    });
    await execFileAsync('git', ['config', 'user.name', 'Snaglet Tests'], { cwd: tmpDir });

    const result = await gitCommitTool(
      {
        cwd: tmpDir,
        message: 'No-op commit',
      },
      {}
    );

    expect(result).toContain('No staged changes to commit');
  });

  it('runs git status through the canonical tool and the permanent old-id alias', async () => {
    await execFileAsync('git', ['init', '-q'], { cwd: tmpDir });
    await writeFile(path.join(tmpDir, 'untracked.txt'), 'status smoke\n', 'utf8');

    const canonical = await gitTool({ subcommand: 'status', cwd: tmpDir }, {});
    expect(typeof canonical === 'string' ? canonical : canonical.output).toContain('untracked.txt');

    const resolution = resolveToolId('git_status');
    expect(resolution.id).toBe('git');
    const aliased = await gitTool(transformToolAliasParams(resolution, { cwd: tmpDir }), {});
    expect(typeof aliased === 'string' ? aliased : aliased.output).toContain('untracked.txt');
  });
});
