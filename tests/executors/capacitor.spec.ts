import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ExecutorContext } from '@nx/devkit';

import capacitorExecutor, { Runner } from '../../src/executors/capacitor/executor';

describe('capacitor executor', () => {
  let root: string;
  let runner: jest.MockedFunction<Runner>;
  const ctx = (): ExecutorContext =>
    ({
      root,
      projectName: 'field',
      projectsConfigurations: { version: 2, projects: { field: { root: 'apps/field' } } },
      isVerbose: false,
    } as unknown as ExecutorContext);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-cap-'));
    fs.mkdirSync(path.join(root, 'apps', 'field', 'node_modules', '@capacitor', 'cli'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, 'apps', 'field', 'package.json'), '{}');
    fs.mkdirSync(path.join(root, 'dist', 'apps', 'field'), { recursive: true });
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    runner = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const appDir = () => path.join(root, 'apps', 'field');

  it('runs npx cap <command> <platform> inside the app folder', async () => {
    const r = await capacitorExecutor({ command: 'sync', platform: 'android' }, ctx(), runner);
    expect(r.success).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(
      'npx --no-install cap sync android',
      expect.objectContaining({ cwd: appDir() }),
    );
  });

  it('installs the app packages first when its node_modules is missing', async () => {
    fs.rmSync(path.join(appDir(), 'node_modules'), { recursive: true });
    await capacitorExecutor({ command: 'open', platform: 'ios' }, ctx(), runner);
    expect(runner.mock.calls.map((c) => c[0])).toEqual([
      'npm install',
      'npx --no-install cap open ios',
    ]);
    expect(runner.mock.calls[0][1]).toEqual(expect.objectContaining({ cwd: appDir() }));
  });

  it.each(['sync', 'copy'] as const)(
    '%s fails clearly when the web build is missing',
    async (command) => {
      fs.rmSync(path.join(root, 'dist', 'apps', 'field'), { recursive: true });
      await expect(
        capacitorExecutor({ command, platform: 'android' }, ctx(), runner),
      ).rejects.toThrow(/dist\/apps\/field.*nx run field:release/s);
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it.each(['add', 'open'] as const)('%s does not need the web build', async (command) => {
    fs.rmSync(path.join(root, 'dist', 'apps', 'field'), { recursive: true });
    await capacitorExecutor({ command, platform: 'android' }, ctx(), runner);
    expect(runner).toHaveBeenCalledWith(
      `npx --no-install cap ${command} android`,
      expect.any(Object),
    );
  });

  it('reinstalls when node_modules exists but @capacitor/cli is missing', async () => {
    fs.rmSync(path.join(appDir(), 'node_modules', '@capacitor'), { recursive: true });
    await capacitorExecutor({ command: 'open', platform: 'android' }, ctx(), runner);
    expect(runner.mock.calls[0][0]).toBe('npm install');
  });

  it('honours a custom webDir', async () => {
    fs.mkdirSync(path.join(root, 'out', 'field'), { recursive: true });
    fs.rmSync(path.join(root, 'dist', 'apps', 'field'), { recursive: true });
    await capacitorExecutor(
      { command: 'sync', platform: 'android', webDir: 'out/field' },
      ctx(),
      runner,
    );
    expect(runner).toHaveBeenCalledWith('npx --no-install cap sync android', expect.any(Object));
  });

  it('rejects an unknown platform or command', async () => {
    await expect(
      capacitorExecutor({ command: 'sync', platform: 'windows' as never }, ctx(), runner),
    ).rejects.toThrow(/platform.*android.*ios/);
    await expect(
      capacitorExecutor({ command: 'rm' as never, platform: 'ios' }, ctx(), runner),
    ).rejects.toThrow(/command.*sync/);
  });

  it('fails when the app has no package.json', async () => {
    fs.rmSync(path.join(appDir(), 'package.json'));
    await expect(
      capacitorExecutor({ command: 'open', platform: 'ios' }, ctx(), runner),
    ).rejects.toThrow(/apps\/field\/package.json/);
  });
});
