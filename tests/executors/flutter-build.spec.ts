import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ExecutorContext } from '@nx/devkit';

import flutterBuildExecutor, { Runner } from '../../src/executors/flutter-build/executor';

const makeContext = (projectName: string, root: string): ExecutorContext =>
  ({ projectName, root, isVerbose: false } as unknown as ExecutorContext);

describe('flutterBuildExecutor', () => {
  let tmpDir: string;
  let projectDir: string;
  let runner: jest.MockedFunction<Runner>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flutter-build-'));
    projectDir = path.join(tmpDir, 'apps', 'my-app');
    fs.mkdirSync(path.join(projectDir, 'env'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'env', 'dev.json'),
      JSON.stringify({ FLUTTER_ENV: 'dev' }),
    );
    runner = jest.fn();
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('builds for web with dart-define-from-file when env file exists', async () => {
    const ctx = makeContext('my-app', tmpDir);
    const result = await flutterBuildExecutor(
      { target: 'web', env: 'dev', dist: 'dist/apps/my-app' },
      ctx,
      runner,
    );
    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('flutter build web --release'),
      expect.any(Object),
    );
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('--dart-define-from-file=env/dev.json'),
      expect.any(Object),
    );
  });

  it('runs flutter serve when serve=true', async () => {
    const ctx = makeContext('my-app', tmpDir);
    const result = await flutterBuildExecutor(
      { target: 'web', env: 'dev', serve: true },
      ctx,
      runner,
    );
    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('flutter run -d web-server'),
      expect.any(Object),
    );
  });

  it('throws when dist is missing for non-serve build', async () => {
    const ctx = makeContext('my-app', tmpDir);
    await expect(flutterBuildExecutor({ target: 'web', env: 'dev' }, ctx, runner)).rejects.toThrow(
      /dist.*required/i,
    );
  });

  it('passes --obfuscate flags for apk target', async () => {
    const ctx = makeContext('my-app', tmpDir);
    const result = await flutterBuildExecutor(
      { target: 'apk', env: 'dev', dist: 'dist/apps/my-app', obfuscate: true },
      ctx,
      runner,
    );
    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith(expect.stringContaining('--obfuscate'), expect.any(Object));
  });

  it('silently skips --obfuscate for web target', async () => {
    const ctx = makeContext('my-app', tmpDir);
    const result = await flutterBuildExecutor(
      { target: 'web', env: 'dev', dist: 'dist/apps/my-app', obfuscate: true },
      ctx,
      runner,
    );
    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      expect.not.stringContaining('--obfuscate'),
      expect.any(Object),
    );
  });

  it('builds for ios with dart-define-from-file', async () => {
    const ctx = makeContext('my-app', tmpDir);
    const result = await flutterBuildExecutor(
      { target: 'ios', env: 'dev', dist: 'dist/apps/my-app' },
      ctx,
      runner,
    );
    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('flutter build ios --release'),
      expect.any(Object),
    );
  });

  it('passes --obfuscate flags for ios target', async () => {
    const ctx = makeContext('my-app', tmpDir);
    const result = await flutterBuildExecutor(
      { target: 'ios', env: 'prod', dist: 'dist/apps/my-app', obfuscate: true },
      ctx,
      runner,
    );
    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith(expect.stringContaining('--obfuscate'), expect.any(Object));
  });

  it('includes --base-href when baseHref option is provided', async () => {
    const ctx = makeContext('my-app', tmpDir);
    const result = await flutterBuildExecutor(
      { target: 'web', env: 'dev', dist: 'dist/apps/my-app', baseHref: '/flutter-app/' },
      ctx,
      runner,
    );
    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      expect.stringContaining('--base-href /flutter-app/'),
      expect.any(Object),
    );
  });

  it('skips --dart-define-from-file when env file does not exist', async () => {
    const ctx = makeContext('my-app', tmpDir);
    const result = await flutterBuildExecutor(
      { target: 'web', env: 'prod', dist: 'dist/apps/my-app' },
      ctx,
      runner,
    );
    expect(result.success).toBe(true);
    expect(runner).toHaveBeenCalledWith(
      expect.not.stringContaining('--dart-define-from-file'),
      expect.any(Object),
    );
  });

  it('runs in the project root from the project configuration', async () => {
    const context = {
      projectName: 'acme-mobile',
      root: tmpDir,
      isVerbose: false,
      projectsConfigurations: {
        version: 2,
        projects: { 'acme-mobile': { root: 'apps/my-app' } },
      },
    } as unknown as ExecutorContext;
    await flutterBuildExecutor(
      { target: 'web', env: 'dev', dist: 'dist/apps/my-app/web' },
      context,
      runner,
    );
    expect(runner.mock.calls[0][1].cwd).toBe(projectDir);
    expect(runner.mock.calls[0][0]).toContain('--output ../../dist/apps/my-app/web');
    expect(runner.mock.calls[0][0]).toContain('--dart-define-from-file=env/dev.json');
  });

  it('serves on the configured port (default 4200)', async () => {
    const ctx = makeContext('my-app', tmpDir);
    await flutterBuildExecutor({ serve: true }, ctx, runner);
    await flutterBuildExecutor({ serve: true, port: 4310 }, ctx, runner);
    expect(runner.mock.calls[0][0]).toContain('--web-port=4200');
    expect(runner.mock.calls[1][0]).toContain('--web-port=4310');
    await expect(flutterBuildExecutor({ serve: true, port: 0 }, ctx, runner)).rejects.toThrow(
      '"port" must be a whole number from 1 to 65535',
    );
  });
});
