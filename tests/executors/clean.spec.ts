import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ExecutorContext } from '@nx/devkit';

import cleanExecutor, {
  cleanPathProblem,
  Runner,
  staysInside,
} from '../../src/executors/clean/executor';

const ctx = (root: string, projectRoot = 'apps/portal'): ExecutorContext =>
  ({
    projectName: 'portal',
    root,
    isVerbose: false,
    projectsConfigurations: { version: 2, projects: { portal: { root: projectRoot } } },
  } as unknown as ExecutorContext);

const hasFlutter = () => true;

describe('clean executor', () => {
  let ws: string;
  let runner: jest.MockedFunction<Runner>;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-clean-'));
    for (const d of ['dist/apps/portal/assets', 'coverage/apps/portal', 'apps/portal/src']) {
      fs.mkdirSync(path.join(ws, d), { recursive: true });
    }
    fs.writeFileSync(path.join(ws, 'dist/apps/portal/index.html'), 'x');
    runner = jest.fn();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('removes the listed outputs and leaves the sources', async () => {
    const r = await cleanExecutor(
      { paths: ['dist/apps/portal', 'coverage/apps/portal', 'tmp/none'] },
      ctx(ws),
      runner,
      hasFlutter,
    );
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(ws, 'dist/apps/portal'))).toBe(false);
    expect(fs.existsSync(path.join(ws, 'coverage/apps/portal'))).toBe(false);
    expect(fs.existsSync(path.join(ws, 'apps/portal/src'))).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });

  it('refuses dangerous paths and removes nothing', async () => {
    const r = await cleanExecutor({ paths: ['dist/apps/portal', '../x'] }, ctx(ws), runner);
    expect(r.success).toBe(false);
    expect(fs.existsSync(path.join(ws, 'dist/apps/portal'))).toBe(true);
  });

  it('refuses paths given as a string', async () => {
    const r = await cleanExecutor({ paths: 'dist/apps/portal' as never }, ctx(ws), runner);
    expect(r.success).toBe(false);
    expect(fs.existsSync(path.join(ws, 'dist/apps/portal'))).toBe(true);
  });

  it.each([
    ['', 'is empty'],
    ['/etc', 'must be relative'],
    ['C:\\work', 'must be relative'],
    ['.', 'is the workspace root'],
    ['../other', 'is outside the workspace'],
    ['dist', 'is a whole output root'],
    ['apps', 'holds the project itself'],
    ['Apps/Portal', 'holds the project itself'],
    ['apps/portal/src', 'is not below dist/'],
    ['Apps/portal/SRC', 'is not below dist/'],
    ['libs/ui/dist', 'is not below dist/'],
    ['node_modules/.cache', 'node_modules'],
    ['NODE_MODULES/x', 'node_modules'],
    ['dist/../.git/x', 'node_modules or .git'],
    ['src', 'is not below dist/'],
    ['src/app', 'is not below dist/'],
    ['mobile/lib', 'is not below dist/'],
    ['www/portal', 'is not below dist/'],
  ])('refuses %j (%s)', (p, why) => {
    expect(cleanPathProblem(p, 'apps/portal')).toContain(why);
  });

  it.each([
    ['dist/apps/portal', 'apps/portal'],
    ['coverage/apps/portal', 'apps/portal'],
    ['tmp/x', 'apps/portal'],
    ['Dist\\apps\\portal', 'apps/portal'],
    ['apps/mobile/www', 'apps/mobile'],
    ['apps/mobile/build/web', 'apps/mobile'],
    ['www', '.'],
    ['build', '.'],
  ])('accepts %j for a project at %j', (p, root) => {
    expect(cleanPathProblem(p, root)).toBeNull();
  });

  it('refuses a whole dist or coverage for a project at the workspace root', () => {
    expect(cleanPathProblem('dist', '.')).toContain('is a whole output root');
    expect(cleanPathProblem('src', '.')).toContain('is not below dist/');
  });

  it('refuses an output folder that is a symlink out of the workspace', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-outside-'));
    fs.mkdirSync(path.join(outside, 'apps/portal'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'apps/portal/keep.txt'), 'x');
    fs.symlinkSync(outside, path.join(ws, 'tmp'), 'dir');
    try {
      expect(staysInside(ws, path.join(ws, 'tmp/apps/portal'))).toBe(false);
      expect(staysInside(ws, path.join(ws, 'dist/apps/portal'))).toBe(true);
      const r = await cleanExecutor({ paths: ['tmp/apps/portal'] }, ctx(ws), runner);
      expect(r.success).toBe(false);
      expect(fs.existsSync(path.join(outside, 'apps/portal/keep.txt'))).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('runs flutter clean in the project folder', async () => {
    const r = await cleanExecutor(
      { paths: [], flutter: true },
      ctx(ws, 'apps/native/mobile'),
      runner,
      hasFlutter,
    );
    expect(r.success).toBe(true);
    expect(runner).toHaveBeenCalledWith('flutter clean', {
      stdio: 'inherit',
      cwd: path.join(ws, 'apps/native/mobile'),
    });
  });

  it('only warns when the flutter CLI is missing, fails on other errors', async () => {
    expect((await cleanExecutor({ flutter: true }, ctx(ws), runner, () => false)).success).toBe(
      true,
    );
    expect(runner).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('not on PATH'));
    runner.mockImplementationOnce(() => {
      throw Object.assign(new Error('not found'), { status: 127 });
    });
    expect((await cleanExecutor({ flutter: true }, ctx(ws), runner, hasFlutter)).success).toBe(
      true,
    );
    runner.mockImplementationOnce(() => {
      throw Object.assign(new Error('boom'), { status: 1 });
    });
    expect((await cleanExecutor({ flutter: true }, ctx(ws), runner, hasFlutter)).success).toBe(
      false,
    );
  });
});
