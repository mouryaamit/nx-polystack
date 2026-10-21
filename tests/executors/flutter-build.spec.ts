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

  describe('stripExif', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
    const sharp = require('sharp') as any;
    const img = () =>
      sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 5, g: 5, b: 5 } } });
    let outDir: string;
    let plain: Buffer;
    let logs: string[];
    let logSpy: jest.SpyInstance;

    beforeEach(async () => {
      outDir = path.join(tmpDir, 'dist', 'apps', 'my-app', 'assets');
      fs.mkdirSync(outDir, { recursive: true });
      plain = await img().png().toBuffer();
      fs.writeFileSync(path.join(outDir, 'plain.png'), plain);
      fs.writeFileSync(
        path.join(outDir, 'photo.jpg'),
        await img()
          .withExif({ IFD0: { Make: 'T' } })
          .jpeg()
          .toBuffer(),
      );
      logs = [];
      logSpy = jest.spyOn(console, 'log').mockImplementation((m: string) => {
        logs.push(m);
      });
    });
    afterEach(() => logSpy.mockRestore());

    const exifOf = async (name: string) =>
      (await sharp(fs.readFileSync(path.join(outDir, name))).metadata()).exif;

    it('is on by default for web: strips EXIF, leaves other images byte-identical', async () => {
      await flutterBuildExecutor(
        { target: 'web', env: 'dev', dist: 'dist/apps/my-app' },
        makeContext('my-app', tmpDir),
        runner,
      );
      expect(await exifOf('photo.jpg')).toBeUndefined();
      expect(fs.readFileSync(path.join(outDir, 'plain.png')).equals(plain)).toBe(true);
      expect(logs).toContain('ℹ strip-exif: 2 scanned, 1 stripped, 1 unchanged, 0 skipped');
    });

    it('stripExif: false leaves the web output alone', async () => {
      await flutterBuildExecutor(
        { target: 'web', env: 'prod', dist: 'dist/apps/my-app', stripExif: false },
        makeContext('my-app', tmpDir),
        runner,
      );
      expect((await exifOf('photo.jpg'))?.length).toBeGreaterThan(0);
      expect(logs).toContain('ℹ strip-exif: off (stripExif: false)');
    });

    it('is not run for apk / ios builds (images are inside the bundle)', async () => {
      await flutterBuildExecutor(
        { target: 'apk', env: 'dev', dist: 'dist/apps/my-app', stripExif: true },
        makeContext('my-app', tmpDir),
        runner,
      );
      expect((await exifOf('photo.jpg'))?.length).toBeGreaterThan(0);
      expect(logs.join('\n')).toContain('stripExif ignored for apk');
    });
  });
});

describe('flutterBuildExecutor build meta (NX-85)', () => {
  let tmpDir: string;
  let runner: jest.MockedFunction<Runner>;
  const decode = (html: string) =>
    JSON.parse(
      Buffer.from(/<meta name="x-build" content="([^"]+)">/.exec(html)![1], 'base64').toString(),
    );

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flutter-meta-'));
    fs.mkdirSync(path.join(tmpDir, 'apps', 'my-app'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'nx'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'node_modules', 'nx', 'package.json'),
      JSON.stringify({ version: '22.7.12' }),
    );
    const out = path.join(tmpDir, 'dist', 'apps', 'my-app');
    runner = jest.fn<void, Parameters<Runner>>(() => {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'index.html'), '<html><head></head><body></body></html>');
    });
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const html = () => fs.readFileSync(path.join(tmpDir, 'dist/apps/my-app/index.html'), 'utf8');

  it('writes the build meta with the tool into web builds', async () => {
    await flutterBuildExecutor(
      { target: 'web', env: 'uat', dist: 'dist/apps/my-app' },
      makeContext('my-app', tmpDir),
      runner,
    );
    const meta = decode(html());
    expect(meta.env).toBe('UAT');
    expect(meta.gen).toMatch(/^nx-polystack@\d+\.\d+\.\d+/);
    expect(meta.nx).toBe('22.7.12');
    expect(meta.ng).toBeUndefined();
  });

  it('buildMeta.gen: false leaves the tool out', async () => {
    await flutterBuildExecutor(
      { target: 'web', env: 'dev', dist: 'dist/apps/my-app', buildMeta: { gen: false } },
      makeContext('my-app', tmpDir),
      runner,
    );
    const meta = decode(html());
    expect(meta.env).toBe('DEV');
    expect(meta.gen).toBeUndefined();
  });

  it('refuses a bad buildMeta before building', async () => {
    await expect(
      flutterBuildExecutor(
        {
          target: 'web',
          dist: 'dist/apps/my-app',
          buildMeta: { gen: 'yes' as unknown as boolean },
        },
        makeContext('my-app', tmpDir),
        runner,
      ),
    ).rejects.toThrow('buildMeta.gen must be true or false');
    expect(runner).not.toHaveBeenCalled();
  });
});
