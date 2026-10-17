import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ExecutorContext } from '@nx/devkit';

import flutterExportExecutor, { Runner } from '../../src/executors/flutter-export/executor';

const makeContext = (root: string): ExecutorContext =>
  ({ root, isVerbose: false } as unknown as ExecutorContext);

describe('flutterExportExecutor', () => {
  let tmpDir: string;
  let runner: jest.MockedFunction<Runner>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flutter-export-'));
    runner = jest.fn();
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('builds the flutterflow CLI command with project and dest', async () => {
    const ctx = makeContext(tmpDir);
    const result = await flutterExportExecutor(
      { flutterfowProject: 'my-project-id', dest: 'apps/flutter-app' },
      ctx,
      runner,
    );
    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('flutterflow export-code'),
      expect.any(Object),
    );
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('my-project-id'),
      expect.any(Object),
    );
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('apps/flutter-app'),
      expect.any(Object),
    );
  });

  it('includes branch-name when branch is provided', async () => {
    const ctx = makeContext(tmpDir);
    await flutterExportExecutor(
      { flutterfowProject: 'pid', dest: 'apps/fa', branch: 'feature/x' },
      ctx,
      runner,
    );
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('--branch-name'),
      expect.any(Object),
    );
  });

  it('defaults to Production environment', async () => {
    const ctx = makeContext(tmpDir);
    await flutterExportExecutor({ flutterfowProject: 'pid', dest: 'apps/fa' }, ctx, runner);
    expect(runner).toHaveBeenCalledWith(expect.stringContaining('Production'), expect.any(Object));
  });
});
